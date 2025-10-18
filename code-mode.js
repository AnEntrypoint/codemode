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
    console.error(`[MCP Manager]   Command: ${serverConfig.command} ${serverConfig.args.join(' ')}`);

    let proc;
    try {
      proc = spawn(serverConfig.command, serverConfig.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: __dirname
      });
      console.error(`[MCP Manager]   Process spawned with PID: ${proc.pid}`);
    } catch (error) {
      console.error(`[MCP Manager]   Failed to spawn process:`, error.message);
      throw error;
    }

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

    proc.stderr.on('data', (data) => {
      console.error(`[MCP Manager] ${serverName} stderr:`, data.toString().trim());
    });
    proc.on('error', (err) => console.error(`[MCP Manager] ${serverName} error:`, err.message));
    proc.on('close', () => {
      console.error(`[MCP Manager] ${serverName} closed`);
      this.servers.delete(serverName);
    });

    console.error(`[MCP Manager]   Sending initialize request...`);
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
    console.error(`[MCP Manager]   Initialize complete`);

    console.error(`[MCP Manager]   Requesting tools list...`);
    const toolsResult = await this.sendRequest(serverName, {
      jsonrpc: '2.0',
      id: serverState.nextId++,
      method: 'tools/list'
    });
    console.error(`[MCP Manager]   Tools list received`);

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

    // Initialize server objects
    for (const [serverName, serverState] of this.mcpManager.servers) {
      functions += `global.${serverName} = global.${serverName} || {};\n`;
      toolDescriptions[serverName] = [];
    }

    functions += '\n';

    for (const [serverName, serverState] of this.mcpManager.servers) {
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

        // Generate function that calls MCP tool via IPC, filtering out null/undefined values
        const paramNamesArray = JSON.stringify(paramNames);
        const requiredArray = JSON.stringify(required);

        functions += `
/**
 * ${serverName}.${tool.name} - ${tool.description}
 * IMPORTANT: This is an async function. Always use 'await' when calling it.
 * Example: const result = await ${serverName}.${tool.name}(${paramNames.slice(0, Math.min(2, paramNames.length)).join(', ')});
 */
global.${serverName}.${tool.name} = ${signature} {
  // Define parameter names and required parameters inside the function
  const paramNames = ${paramNamesArray};
  const required = ${requiredArray};

  // Flexible parameter handling for various LLM coding styles
  let args = {};

  // Handle different calling patterns that LLMs might generate:
  if (paramNames.length > 0 && typeof ${safeParamNames[0]} === 'object' && ${safeParamNames[0]} !== null && !Array.isArray(${safeParamNames[0]})) {
    // Object-style call: Write({file_path: '...', content: '...'})
    args = ${safeParamNames[0]};
  } else {
    // Individual params call: Write('file.txt', 'content')
    // Also handle missing/undefined parameters gracefully
${paramNames.map((p, i) => `    if (${safeParamNames[i]} !== null && ${safeParamNames[i]} !== undefined) args.${p} = ${safeParamNames[i]};`).join('\n')}
  }

  // Common parameter name variations for LLM flexibility
  const paramMappings = {
    'file_path': ['filePath', 'filename', 'path', 'file'],
    'content': ['text', 'data', 'body'],
    'old_string': ['oldString', 'oldText', 'find'],
    'new_string': ['newString', 'newText', 'replace'],
    'file': ['file_path', 'filePath'],
    'text': ['content', 'data'],
    'command': ['cmd'],
    'description': ['desc'],
    'url': ['uri', 'link']
  };

  // Apply parameter name mappings for flexibility
  for (const [canonical, alternatives] of Object.entries(paramMappings)) {
    if (!args[canonical]) {
      for (const alt of alternatives) {
        if (args[alt] !== undefined) {
          args[canonical] = args[alt];
          break;
        }
      }
    }
  }

  // Validate required parameters AFTER mapping (this is the fix!)
  for (const paramName of required) {
    if (args[paramName] === null || args[paramName] === undefined) {
      throw new Error('Missing required parameter: ' + paramName);
    }
  }

  return await global.__callMCPTool('${serverName}', '${tool.name}', args);
};

`;
      }
    }

    // Add global aliases for commonly used built-in tools with path resolution
    functions += `
// Global aliases for built-in tools with automatic path resolution
// Simple path resolution without importing (cross-platform compatible)
const resolvePath = (filePath) => {
  if (!filePath) return filePath;
  // Check if absolute path (works for both Windows and Unix)
  if (filePath.match(/^([a-zA-Z]:)?[\\\\\\/]/) || filePath.startsWith('/')) return filePath;
  const workingDir = global.__workingDirectory || process.cwd();
  // Simple path joining
  const normalized = filePath.replace(/\\\\/g, '/');
  return workingDir.replace(/\\\\/g, '/') + '/' + normalized;
};

global.TodoWrite = async (todos) => await builtInTools.TodoWrite({ todos });
global.LS = async (lsPath, show_hidden, recursive, files_only) => {
  // Map files_only to as_array parameter (built-in tools uses as_array, not files_only)
  const result = await builtInTools.LS({ path: resolvePath(lsPath), show_hidden, recursive, as_array: files_only });
  // If as_array was requested, the result will be a JSON string that needs parsing
  if (files_only && typeof result === 'string') {
    try {
      // Try to parse as JSON array first
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (e) {
      // If not JSON, split string into array
      return result.split('\\n').filter(line => line.trim() !== '' && line !== 'Empty directory');
    }
  }
  return result;
};
global.Read = async (file_path, offset, limit) => await builtInTools.Read({ file_path: resolvePath(file_path), offset, limit });
global.Write = async (file_path, content) => await builtInTools.Write({ file_path: resolvePath(file_path), content });
global.Edit = async (file_path, old_string, new_string, replace_all) => await builtInTools.Edit({ file_path: resolvePath(file_path), old_string, new_string, replace_all });
global.Bash = async (command, description, timeout) => await builtInTools.Bash({ command, description, timeout });
global.Glob = async (pattern, globPath) => await builtInTools.Glob({ pattern, path: resolvePath(globPath) });
global.Grep = async (pattern, grepPath, options) => await builtInTools.Grep({ pattern, path: resolvePath(grepPath), ...options });
`;

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
    mcpToolsList = '\n\n## Available MCP Tools:\n\nAll MCP tools are organized by server name as objects. Use the format: `serverName.toolName(params)`\n';
    for (const [serverName, tools] of Object.entries(toolDescriptions)) {
      mcpToolsList += `\n### ${serverName}:\n`;
      tools.forEach(tool => {
        const params = Object.keys(tool.inputSchema?.properties || {})
          .map(p => tool.inputSchema.required?.includes(p) ? p : `${p}?`)
          .join(', ');
        mcpToolsList += `- ${serverName}.${tool.name}(${params}): ${tool.description}\n`;
      });
    }
  }

  const description = `Execute JavaScript code with access to all MCP tools. Both MCP connections and execution context persist across calls - use clear_context() to reset.${mcpToolsList}\n\n**Special Functions:**\n- clear_context(): Clear all variables and state in the execution context\n\n**Examples:**\n- await builtInTools.Bash('ls -la')\n- await playwright.browser_navigate('https://example.com')\n- await builtInTools.Read('file.txt')`;

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

  if (name === 'execute') {
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
          content: [{ type: 'text', text: result.output || 'Unknown error' }],
          isError: true
        };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true
  };
});


async function main() {
  const config = loadConfig();

  // Initialize persistent MCP servers with error handling
  try {
    await mcpManager.initialize(config);
    console.error('[Execute Server] MCP servers initialized successfully');
  } catch (error) {
    console.error('[Execute Server] MCP server initialization failed, using fallback mode:', error.message);
  }

  // Initialize persistent execution context with error handling
  try {
    executionContext = new ExecutionContextManager(mcpManager);
    await executionContext.initialize();
    console.error('[Execute Server] Execution context initialized successfully');
  } catch (error) {
    console.error('[Execute Server] Execution context initialization failed:', error.message);
    // Continue without MCP servers - use fallback mode
  }

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
