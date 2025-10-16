#!/usr/bin/env node

// Unified MCP Server - Exposes call tool with access to all configured MCP servers
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load MCP server configuration
function loadConfig() {
  const paths = [
    join(__dirname, '.codemode.json'),
    join(process.env.HOME || process.env.USERPROFILE || '~', '.claude', '.codemode.json')
  ];

  for (const configPath of paths) {
    try {
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        console.error(`[MCP Server] Using config: ${configPath}`);
        return config;
      }
    } catch (error) {
      console.error(`[MCP Server] Error reading ${configPath}:`, error.message);
    }
  }

  console.error('[MCP Server] No .codemode.json found, using empty config');
  return { mcpServers: {} };
}

class UnifiedMCPServer {
  constructor() {
    this.clients = new Map(); // serverName -> { process, tools, config }
    this.requestId = 0;
    this.pendingRequests = new Map();

    this.server = new Server(
      {
        name: 'unified-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  async connectToServer(serverName, serverConfig) {
    return new Promise((resolve, reject) => {
      console.error(`[MCP Server] Connecting to: ${serverName}`);

      const clientProcess = spawn(serverConfig.command, serverConfig.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: __dirname
      });

      let responseBuffer = '';

      clientProcess.stderr.on('data', (data) => {
        console.error(`[${serverName}] ${data.toString().trim()}`);
      });

      clientProcess.stdout.on('data', (data) => {
        responseBuffer += data.toString();
        let lines = responseBuffer.split('\n');
        responseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              this.handleResponse(response);
            } catch (error) {
              console.error(`[${serverName}] Failed to parse response:`, line);
            }
          }
        }
      });

      clientProcess.on('error', (error) => {
        console.error(`[${serverName}] Process error:`, error.message);
        reject(error);
      });

      clientProcess.on('close', (code) => {
        console.error(`[${serverName}] Process closed with code: ${code}`);
      });

      // Wait for server to start and get tools
      setTimeout(async () => {
        try {
          const toolsResponse = await this.sendRequest(clientProcess, 'tools/list');
          const tools = toolsResponse.result?.tools || [];

          // Store client and tools
          this.clients.set(serverName, {
            process: clientProcess,
            tools: tools,
            config: serverConfig
          });

          console.error(`✓ ${serverName}: ${tools.length} tools`);
          resolve();
        } catch (error) {
          console.error(`✗ ${serverName}: ${error.message}`);
          reject(error);
        }
      }, 1000);
    });
  }

  sendRequest(clientProcess, method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for ${method}`));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      clientProcess.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  handleResponse(response) {
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      this.pendingRequests.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response);
      }
    }
  }

  setupHandlers() {
    // List tools - only expose the call tool
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allServers = Array.from(this.clients.keys());
      const totalTools = Array.from(this.clients.values()).reduce((sum, client) => sum + client.tools.length, 0);

      return {
        tools: [
          {
            name: 'call',
            description: `Execute JavaScript code with access to ${totalTools} tools from ${allServers.length} MCP servers (${allServers.join(', ')}). Available tools: Read, Write, Edit, Glob, Grep, Bash, LS, WebFetch, WebSearch, TodoWrite, Task, and any tools from loaded MCP servers.`,
            inputSchema: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description: 'JavaScript code to execute. Has access to all tools from connected MCP servers.'
                },
                workingDirectory: {
                  type: 'string',
                  description: 'Directory to execute code in (defaults to current directory)',
                  default: process.cwd()
                }
              },
              required: ['code']
            }
          }
        ]
      };
    });

    // Call tool - handle call requests
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name !== 'call') {
        return {
          content: [{
            type: 'text',
            text: `Unknown tool: ${name}. Only 'call' tool is available.`
          }],
          isError: true
        };
      }

      try {
        // Generate JavaScript code with all MCP functions
        const jsCode = this.generateExecuteCode(args.code, args.workingDirectory);

        // Execute using code-mode.js
        const result = await this.executeCode(jsCode, args.workingDirectory);

        return result;
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Execution error: ${error.message}`
          }],
          isError: true
        };
      }
    });
  }

  generateExecuteCode(userCode, workingDirectory) {
    // Generate all MCP function definitions
    let functionDefinitions = '';
    const functionNames = new Set();

    for (const [serverName, client] of this.clients.entries()) {
      for (const tool of client.tools) {
        // Handle naming conflicts
        let functionName = tool.name;
        if (functionNames.has(functionName)) {
          functionName = `${serverName}_${tool.name}`;
        }
        functionNames.add(functionName);

        // Generate function
        const jsFunction = this.generateJSFunction(functionName, tool, serverName);
        functionDefinitions += jsFunction + '\n\n';
      }
    }

    return `
// Generated MCP Functions from ${this.clients.size} servers
${functionDefinitions}

// User code
${userCode}
`;
  }

  generateJSFunction(functionName, tool, serverName) {
    const params = tool.inputSchema?.properties || {};
    const requiredParams = tool.inputSchema?.required || [];
    const paramNames = Object.keys(params);

    // Generate parameter validation
    const validationCode = requiredParams.map(param =>
      `  if (${param} === undefined) throw new Error('Missing required parameter: ${param}');`
    ).join('\n');

    // Generate function signature with default values
    const signatureParams = paramNames.map(param => {
      const isRequired = requiredParams.includes(param);
      return isRequired ? param : `${param} = null`;
    }).join(', ');

    // Generate arguments object
    const argsObject = paramNames.map(param => `${param}: ${param}`).join(', ');

    return `async function ${functionName}(${signatureParams}) {
${validationCode ? validationCode + '\n' : ''}  const args = { ${argsObject} };

  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('${client.config.command}', ${JSON.stringify(client.config.args)}, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '${__dirname}'
    });

    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errorOutput || 'Process failed'));
        return;
      }

      try {
        const response = JSON.parse(output);
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      } catch (e) {
        reject(new Error('Invalid JSON response: ' + output));
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });

    const request = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: '${tool.name}',
        arguments: args
      }
    };

    proc.stdin.write(JSON.stringify(request) + '\\n');
  });
}`;
  }

  async executeCode(code, workingDirectory) {
    return new Promise((resolve, reject) => {
      console.error(`[MCP Server] Executing code in: ${workingDirectory}`);

      const proc = spawn('node', ['code-mode.js'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: __dirname
      });

      let output = '';
      let errorOutput = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(errorOutput || 'Process failed'));
          return;
        }

        try {
          const response = JSON.parse(output);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        } catch (e) {
          reject(new Error('Invalid JSON response: ' + output));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });

      // Send execute request
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'execute',
          arguments: {
            workingDirectory,
            code,
            timeout: 120000
          }
        }
      };

      proc.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async start() {
    console.error('[MCP Server] Starting Unified MCP Server...');

    const config = loadConfig();
    const serverEntries = Object.entries(config.mcpServers || {});

    if (serverEntries.length === 0) {
      console.error('[MCP Server] No MCP servers configured');
      process.exit(1);
    }

    console.error(`[MCP Server] Connecting to ${serverEntries.length} MCP servers...`);

    // Connect to all servers in parallel
    const connectionPromises = serverEntries.map(([serverName, serverConfig]) =>
      this.connectToServer(serverName, serverConfig)
    );

    try {
      await Promise.all(connectionPromises);

      const totalTools = Array.from(this.clients.values()).reduce((sum, client) => sum + client.tools.length, 0);
      console.error(`[MCP Server] Connected to ${this.clients.size} servers with ${totalTools} total tools`);
      console.error(`[MCP Server] Available servers: ${Array.from(this.clients.keys()).join(', ')}`);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('[MCP Server] Unified MCP Server running on stdio');
      console.error('[MCP Server] Exposing single call tool with access to all MCP functions');
    } catch (error) {
      console.error('[MCP Server] Failed to connect to servers:', error.message);
      process.exit(1);
    }
  }

  async shutdown() {
    for (const [serverName, client] of this.clients.entries()) {
      try {
        client.process.kill();
        console.error(`[MCP Server] Disconnected from: ${serverName}`);
      } catch (error) {
        console.error(`[MCP Server] Error disconnecting from ${serverName}:`, error.message);
      }
    }
    this.clients.clear();
  }
}

// Handle graceful shutdown
const mcpServer = new UnifiedMCPServer();

process.on('SIGINT', async () => {
  console.error('\n[MCP Server] Shutting down...');
  await mcpServer.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\n[MCP Server] Shutting down...');
  await mcpServer.shutdown();
  process.exit(0);
});

// Start the MCP server
mcpServer.start().catch((error) => {
  console.error('[MCP Server] Fatal error:', error);
  process.exit(1);
});