#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn, fork } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadConfig() {
  const noMcp = process.argv.includes('--nomcp');
  if (noMcp) {
    console.error('[Execute Server] --nomcp flag detected, MCP tools disabled');
    return { mcpServers: {} };
  }

  const paths = [
    join(process.cwd(), '.codemode.json'),
    join(__dirname, '.codemode.json'),
    join(process.env.HOME || process.env.USERPROFILE || '~', '.claude', '.codemode.json')
  ];

  for (const configPath of paths) {
    try {
      if (existsSync(configPath)) {
        console.error(`[Execute Server] Loading config from: ${configPath}`);
        return JSON.parse(readFileSync(configPath, 'utf8'));
      }
    } catch (error) {
      console.error(`[Execute Server] Failed to load config from ${configPath}:`, error.message);
    }
  }

  console.error('[Execute Server] No config found, using empty config');
  return { mcpServers: {} };
}

// Global MCP Server Manager with persistent connections
class MCPServerManager {
  constructor() {
    this.servers = new Map();
  }

  async initialize(config) {
    console.error('[MCP Manager] Initializing persistent MCP servers...');

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers || {})) {
      if (serverName === 'codeMode') continue;

      try {
        await this.startServer(serverName, serverConfig);
      } catch (error) {
        console.error(`[MCP Manager] Failed to start ${serverName}:`, error.message);
      }
    }

    console.error('[MCP Manager] Initialization complete');
  }

  async startServer(serverName, serverConfig) {
    console.error(`[MCP Manager] Starting ${serverName}...`);

    const proc = spawn(serverConfig.command, serverConfig.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: __dirname
    });

    const serverState = {
      process: proc,
      tools: [],
      nextId: 0,
      buffer: '',
      pendingCalls: new Map()
    };

    this.servers.set(serverName, serverState);

    proc.stdout.on('data', (data) => {
      serverState.buffer += data.toString();
      const lines = serverState.buffer.split('\n');
      serverState.buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            if (serverState.pendingCalls.has(response.id)) {
              const { resolve, reject } = serverState.pendingCalls.get(response.id);
              serverState.pendingCalls.delete(response.id);

              if (response.error) {
                reject(new Error(response.error.message || JSON.stringify(response.error)));
              } else {
                resolve(response.result);
              }
            }
          } catch (e) {}
        }
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('error', (err) => console.error(`[MCP Manager] ${serverName} error:`, err.message));
    proc.on('close', () => {
      console.error(`[MCP Manager] ${serverName} closed`);
      this.servers.delete(serverName);
    });

    await this.sendRequest(serverName, {
      jsonrpc: '2.0',
      id: serverState.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codemode-agent', version: '1.0.0' }
      }
    });

    const toolsResult = await this.sendRequest(serverName, {
      jsonrpc: '2.0',
      id: serverState.nextId++,
      method: 'tools/list'
    });

    serverState.tools = toolsResult.tools || [];

    console.error(`[MCP Manager] ✓ ${serverName}: ${serverState.tools.length} tool(s) loaded`);
    serverState.tools.forEach(tool => console.error(`[MCP Manager]    - ${tool.name}`));
  }

  async sendRequest(serverName, request) {
    const serverState = this.servers.get(serverName);
    if (!serverState) throw new Error(`MCP server ${serverName} not found`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        serverState.pendingCalls.delete(request.id);
        reject(new Error(`MCP request timeout for ${serverName}`));
      }, 60000);

      serverState.pendingCalls.set(request.id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });

      serverState.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async callTool(serverName, toolName, args) {
    const serverState = this.servers.get(serverName);
    if (!serverState) throw new Error(`MCP server ${serverName} not found`);

    const result = await this.sendRequest(serverName, {
      jsonrpc: '2.0',
      id: serverState.nextId++,
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    });

    const content = result.content;
    if (Array.isArray(content) && content[0]?.type === 'text') {
      return content[0].text;
    }
    return JSON.stringify(result);
  }

  getAllTools() {
    const allTools = {};
    for (const [serverName, serverState] of this.servers) {
      allTools[serverName] = serverState.tools;
    }
    return allTools;
  }

  shutdown() {
    for (const [serverName, serverState] of this.servers) {
      console.error(`[MCP Manager] Shutting down ${serverName}`);
      serverState.process.kill();
    }
    this.servers.clear();
  }
}

// Persistent Execution Context Manager
class ExecutionContextManager {
  constructor(mcpManager) {
    this.mcpManager = mcpManager;
    this.worker = null;
    this.nextId = 0;
    this.pendingExecutions = new Map();
    this.initialized = false;
  }

  async initialize() {
    console.error('[Execution Context] Creating persistent Node.js worker with IPC...');

    this.worker = fork(join(__dirname, 'execution-worker.js'), [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });

    // Handle IPC messages from worker
    this.worker.on('message', async (msg) => {
      if (msg.type === 'MCP_CALL') {
        // Worker is calling an MCP tool
        const { callId, serverName, toolName, args } = msg;

        try {
          const result = await this.mcpManager.callTool(serverName, toolName, args);
          this.worker.send({
            type: 'MCP_RESULT',
            callId,
            success: true,
            result
          });
        } catch (error) {
          this.worker.send({
            type: 'MCP_RESULT',
            callId,
            success: false,
            result: error.message
          });
        }
      } else if (msg.type === 'EXEC_RESULT') {
        // Execution completed
        const { execId, success, output, error } = msg;

        if (this.pendingExecutions.has(execId)) {
          const { resolve } = this.pendingExecutions.get(execId);
          this.pendingExecutions.delete(execId);
          resolve({ success, output: success ? output : error });
        }
      } else if (msg.type === 'INIT_COMPLETE') {
        this.initialized = true;
        console.error('[Execution Context] Worker initialized');
      }
    });

    this.worker.on('error', (err) => {
      console.error('[Execution Context] Worker error:', err.message);
    });

    this.worker.on('exit', (code) => {
      console.error(`[Execution Context] Worker exited with code ${code}`);
      this.worker = null;
      this.initialized = false;
    });

    // Send tool functions to worker
    const { functions } = this.generateMCPFunctions();

    this.worker.send({
      type: 'INIT_TOOLS',
      toolFunctions: functions
    });

    // Wait for initialization
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.initialized) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  getAllToolNames() {
    const names = {};
    for (const [serverName, serverState] of this.mcpManager.servers) {
      for (const tool of serverState.tools) {
        names[tool.name] = true;
      }
    }
    return names;
  }

  generateMCPFunctions() {
    let functions = '';
    const toolDescriptions = {};

    for (const [serverName, serverState] of this.mcpManager.servers) {
      toolDescriptions[serverName] = [];

      for (const tool of serverState.tools) {
        toolDescriptions[serverName].push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        });

        const params = tool.inputSchema?.properties || {};
        const required = tool.inputSchema?.required || [];
        const paramNames = Object.keys(params);

        const reservedWords = ['function', 'class', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while'];
        const safeParamNames = paramNames.map(p => reservedWords.includes(p) ? `_${p}` : p);

        const signature = `async function ${tool.name}(${safeParamNames.map((p, i) => {
          const isRequired = required.includes(paramNames[i]);
          return isRequired ? p : `${p} = null`;
        }).join(', ')})`;

        let validation = '';
        if (required.length > 0) {
          validation = required.map(p => {
            const idx = paramNames.indexOf(p);
            const safeName = safeParamNames[idx];
            return `  if (${safeName} === null || ${safeName} === undefined) throw new Error('Missing required parameter: ${p}');`;
          }).join('\n');
        }

        const argsStr = paramNames.map((p, i) => `${p}: ${safeParamNames[i]}`).join(', ');

        // Generate function that calls MCP tool via IPC
        functions += `
global.${tool.name} = ${signature} {
${validation ? validation + '\n' : ''}  return await global.__callMCPTool('${serverName}', '${tool.name}', { ${argsStr} });
};

`;
      }
    }

    return { functions, toolDescriptions };
  }

  async execute(code, workingDirectory) {
    if (!this.worker || !this.initialized) {
      throw new Error('Execution worker not initialized');
    }

    const execId = this.nextId++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingExecutions.delete(execId);
        reject(new Error('Execution timeout'));
      }, 120000);

      this.pendingExecutions.set(execId, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        }
      });

      this.worker.send({
        type: 'EXECUTE',
        execId,
        code,
        workingDirectory
      });
    });
  }

  clearContext() {
    if (this.worker && this.initialized) {
      this.worker.send({
        type: 'EXECUTE',
        execId: -1, // Special ID for clear_context
        code: 'clear_context()',
        workingDirectory: process.cwd()
      });
    }
  }

  shutdown() {
    if (this.worker) {
      console.error('[Execution Context] Shutting down worker');
      this.worker.kill();
      this.worker = null;
    }
  }
}

const mcpManager = new MCPServerManager();
let executionContext = null;

const server = new Server(
  { name: 'codemode-execute', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!executionContext) return { tools: [] };

  const { toolDescriptions } = executionContext.generateMCPFunctions();

  let mcpToolsList = '';
  if (Object.keys(toolDescriptions).length > 0) {
    mcpToolsList = '\n## Available Tools by MCP Server:\n';
    for (const [serverName, tools] of Object.entries(toolDescriptions)) {
      mcpToolsList += `\n### ${serverName}:\n`;
      tools.forEach(tool => {
        const params = Object.keys(tool.inputSchema?.properties || {})
          .map(p => tool.inputSchema.required?.includes(p) ? p : `${p}?`)
          .join(', ');
        mcpToolsList += `- ${tool.name}(${params}): ${tool.description}\n`;
      });
    }
  }

  const description = `Execute JavaScript code with access to all MCP tools. Both MCP connections and execution context persist across calls - use clear_context() to reset.${mcpToolsList}\n\n**Special Functions:**\n- clear_context(): Clear all variables and state in the execution context`;

  return {
    tools: [
      {
        name: 'execute',
        description,
        inputSchema: {
          type: 'object',
          properties: {
            workingDirectory: {
              type: 'string',
              description: 'Path to working directory for execution'
            },
            code: {
              type: 'string',
              description: 'JavaScript code to execute. Context persists between calls.'
            }
          },
          required: ['workingDirectory', 'code']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== 'execute') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true
    };
  }

  try {
    const { code, workingDirectory } = args;

    if (!code || !workingDirectory) {
      throw new Error('code and workingDirectory are required');
    }

    const absWorkingDir = resolve(workingDirectory);
    if (!existsSync(absWorkingDir)) {
      throw new Error(`Working directory does not exist: ${absWorkingDir}`);
    }

    const result = await executionContext.execute(code, absWorkingDir);

    if (result.success) {
      return {
        content: [{ type: 'text', text: result.output || 'Code executed successfully' }]
      };
    } else {
      return {
        content: [{ type: 'text', text: `Error: ${result.error}` }],
        isError: true
      };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

async function main() {
  const config = loadConfig();

  // Initialize persistent MCP servers
  await mcpManager.initialize(config);

  // Initialize persistent execution context
  executionContext = new ExecutionContextManager(mcpManager);
  await executionContext.initialize();

  // Handle shutdown
  const shutdown = () => {
    console.error('[Execute Server] Shutting down...');
    executionContext.shutdown();
    mcpManager.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CodeMode Execute MCP Server running with persistent context');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
