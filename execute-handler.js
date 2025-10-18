import { spawn, fork } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadConfig() {
  const noMcp = process.argv.includes('--nomcp');
  if (noMcp) {
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
        return JSON.parse(readFileSync(configPath, 'utf8'));
      }
    } catch (error) {
      // Continue to next path
    }
  }

  return { mcpServers: {} };
}

// MCP Server Manager
class MCPServerManager {
  constructor() {
    this.servers = new Map();
  }

  async initialize(config) {
    console.error('[MCP Manager] Initializing with config:', JSON.stringify(config, null, 2));

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers || {})) {
      if (serverName === 'codeMode') continue;

      console.error(`[MCP Manager] Starting server: ${serverName}`);
      try {
        await this.startServer(serverName, serverConfig);
        console.error(`[MCP Manager] Successfully started ${serverName}`);
      } catch (error) {
        console.error(`[MCP Manager] Failed to start MCP server ${serverName}:`, error.message);
        console.error(`[MCP Manager] Server config:`, serverConfig);
      }
    }
  }

  async startServer(serverName, serverConfig) {
    let proc;
    try {
      proc = spawn(serverConfig.command, serverConfig.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: __dirname
      });
    } catch (error) {
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
                reject(new Error(response.error.message || 'MCP error'));
              } else {
                resolve(response.result);
              }
            }
          } catch (err) {
            // Ignore parse errors
          }
        }
      }
    });

    // Initialize connection
    await this.sendRequest(serverName, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        clientInfo: {
          name: 'codemode-agent',
          version: '2.0.25'
        }
      }
    });

    // List tools
    const toolsResponse = await this.sendRequest(serverName, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    if (toolsResponse && toolsResponse.tools) {
      serverState.tools = toolsResponse.tools;
    }
  }

  async sendRequest(serverName, request) {
    const serverState = this.servers.get(serverName);
    if (!serverState) throw new Error(`Server ${serverName} not found`);

    return new Promise((resolve, reject) => {
      serverState.pendingCalls.set(request.id, { resolve, reject });
      serverState.process.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        if (serverState.pendingCalls.has(request.id)) {
          serverState.pendingCalls.delete(request.id);
          reject(new Error('Request timeout'));
        }
      }, 60000);
    });
  }

  async callTool(serverName, toolName, args) {
    const serverState = this.servers.get(serverName);
    if (!serverState) throw new Error(`Server ${serverName} not found`);

    const requestId = serverState.nextId++;
    const response = await this.sendRequest(serverName, {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    });
    return response;
  }

  shutdown() {
    for (const [serverName, serverState] of this.servers) {
      if (serverState.process) {
        serverState.process.kill();
      }
    }
    this.servers.clear();
  }
}

// Execution Context Manager
class ExecutionContextManager {
  constructor(mcpManager) {
    this.mcpManager = mcpManager;
    this.worker = null;
    this.nextId = 0;
    this.pendingExecutions = new Map();
    this.initialized = false;
  }

  async initialize() {
    this.worker = fork(join(__dirname, 'execution-worker.js'), [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });

    this.worker.on('message', async (msg) => {
      if (msg.type === 'MCP_CALL') {
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
        const { execId, success, output, error } = msg;

        if (this.pendingExecutions.has(execId)) {
          const { resolve } = this.pendingExecutions.get(execId);
          this.pendingExecutions.delete(execId);
          resolve({ success, output: success ? output : error });
        }
      } else if (msg.type === 'INIT_COMPLETE') {
        this.initialized = true;
      }
    });

    this.worker.on('error', (err) => {
      console.error('Worker error:', err.message);
    });

    this.worker.on('exit', (code) => {
      this.worker = null;
      this.initialized = false;
    });

    // Generate and send tool functions
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

  generateMCPFunctions() {
    let functions = '';

    for (const [serverName, serverState] of this.mcpManager.servers) {
      functions += `global.${serverName} = global.${serverName} || {};\n`;
    }

    functions += '\n';

    for (const [serverName, serverState] of this.mcpManager.servers) {
      for (const tool of serverState.tools) {
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

        functions += `
global.${serverName}.${tool.name} = ${signature} {
${validation ? validation + '\n' : ''}  const args = {};
${paramNames.map((p, i) => `  if (${safeParamNames[i]} !== null && ${safeParamNames[i]} !== undefined) args.${p} = ${safeParamNames[i]};`).join('\n')}
  return await global.__callMCPTool('${serverName}', '${tool.name}', args);
};

`;
      }
    }

    // Add global aliases for commonly used tools
    functions += `
// Global aliases for commonly used tools
global.TodoWrite = async (todos) => await builtInTools.TodoWrite({ todos });
global.LS = async (path, show_hidden, recursive) => await builtInTools.LS({ path, show_hidden, recursive });
global.Read = async (file_path, offset, limit) => await builtInTools.Read({ file_path, offset, limit });
global.Write = async (file_path, content) => await builtInTools.Write({ file_path, content });
global.Edit = async (file_path, old_string, new_string, replace_all) => await builtInTools.Edit({ file_path, old_string, new_string, replace_all });
global.Bash = async (command, description, timeout) => await builtInTools.Bash({ command, description, timeout });
global.Glob = async (pattern, path) => await builtInTools.Glob({ pattern, path });
global.Grep = async (pattern, path, options) => await builtInTools.Grep({ pattern, path, ...options });
`;

    return { functions };
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

  shutdown() {
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
    }
  }
}

// Global execution context (singleton)
let mcpManager = null;
let executionContext = null;
let initialized = false;

// Initialize on first call
async function ensureInitialized() {
  if (initialized) return;

  const config = loadConfig();
  mcpManager = new MCPServerManager();
  await mcpManager.initialize(config);

  executionContext = new ExecutionContextManager(mcpManager);
  await executionContext.initialize();

  initialized = true;

  // Handle process shutdown
  const shutdown = () => {
    if (executionContext) executionContext.shutdown();
    if (mcpManager) mcpManager.shutdown();
  };

  process.on('exit', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function executeCode(args) {
  await ensureInitialized();

  const { code, workingDirectory } = args;

  if (!code) {
    throw new Error('code is required');
  }

  // Default to current directory if workingDirectory not provided
  const absWorkingDir = resolve(workingDirectory || process.cwd());
  if (!existsSync(absWorkingDir)) {
    throw new Error(`Working directory does not exist: ${absWorkingDir}`);
  }

  const result = await executionContext.execute(code, absWorkingDir);

  if (result.success) {
    return result.output || 'Code executed successfully';
  } else {
    throw new Error(result.output || 'Unknown error');
  }
}
