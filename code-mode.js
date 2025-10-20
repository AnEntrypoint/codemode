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
    return { config: { mcpServers: {} }, configDir: process.cwd() };
  }

  const configPath = join(process.cwd(), '.codemode.json');

  try {
    if (existsSync(configPath)) {
      console.error(`[Execute Server] Loading config from: ${configPath}`);
      return {
        config: JSON.parse(readFileSync(configPath, 'utf8')),
        configDir: dirname(configPath)
      };
    } else {
      console.error(`BRUTAL ERROR: Config file not found at ${configPath} - NO FALLBACKS - Create .codemode.json in current working directory`);
      throw new Error(`BRUTAL ERROR: Config file not found: ${configPath} - NO FALLBACK PATHS EXIST`);
    }
  } catch (error) {
    console.error(`BRUTAL ERROR: Failed to load config from ${configPath}:`, error.message);
    console.error(`BRUTAL ERROR: This is the ONLY config location - no fallback paths exist`);
    throw new Error(`BRUTAL ERROR: Config loading failed - NO FALLBACKS: ${error.message}`);
  }
}

// Global MCP Server Manager with persistent connections
class MCPServerManager {
  constructor() {
    this.servers = new Map();
  }

  async initialize(config, configDir) {
    console.error('[MCP Manager] Initializing persistent MCP servers...');
    this.configDir = configDir;

    if (!config.mcpServers) {
    throw new Error('BRUTAL ERROR: config.mcpServers is undefined - NO FALLBACKS');
  }
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverName === 'codemode') continue;

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

    // Resolve relative paths in args relative to config directory
    const resolvedArgs = serverConfig.args.map(arg => {
      // If arg looks like a relative path to a .js file and doesn't start with a flag
      if (arg.endsWith('.js') && !arg.startsWith('-') && !arg.startsWith('/')) {
        const resolved = join(this.configDir, arg);
        console.error(`[MCP Manager]   Resolved ${arg} -> ${resolved}`);
        return resolved;
      }
      return arg;
    });

    console.error(`[MCP Manager]   Command: ${serverConfig.command} ${resolvedArgs.join(' ')}`);

    let proc;
    try {
      proc = spawn(serverConfig.command, resolvedArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd()
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
                if (!response.error.message) {
                  console.error('BRUTAL ERROR: response.error has no message property:', response.error);
                  reject(new Error(`BRUTAL ERROR: MCP error without message: ${JSON.stringify(response.error)}`));
                } else {
                  reject(new Error(response.error.message));
                }
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

    if (!toolsResult.tools) {
      console.error('BRUTAL ERROR: toolsResult.tools is undefined or null - NO FALLBACKS');
      throw new Error('BRUTAL ERROR: toolsResult.tools is undefined - NO FALLBACKS');
    }
    serverState.tools = toolsResult.tools;

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
      try {
        serverState.process.kill('SIGTERM');
        setTimeout(() => {
          if (!serverState.process.killed) {
            serverState.process.kill('SIGKILL');
          }
        }, 1000);
      } catch (error) {}
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

    this.worker = fork(join(__dirname, 'enhanced-execution-worker.js'), [], {
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
      } else if (msg.type === 'STREAM_OUTPUT') {
        // Progressive stdout streaming
        const { execId, output } = msg;
        process.stdout.write(output + '\n');
      } else if (msg.type === 'INTERACTIVE_SESSION_START') {
        // Execution became interactive - show persistent prompt
        const { execId, message } = msg;
        console.error(`[Execution Context] ${message} (execId: ${execId})`);
        console.error('[Execution Context] Stdin writes will be eagerly queued and delivered immediately');
      } else if (msg.type === 'WAITING_FOR_STDIN') {
        // Execution is waiting for stdin input
        const { execId, message } = msg;
        console.error(`[Execution Context] ${message} (execId: ${execId})`);
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
      } else if (msg.type === 'KILL_EXECUTION') {
        // Forward kill execution request to worker
        this.worker.send(msg);
      } else if (msg.type === 'GET_SERVER_STATE') {
        // Forward server state request to worker
        this.worker.send(msg);
      } else if (msg.type === 'EXECUTION_KILLED') {
        // Worker reports execution killed - forward to pending handler
        console.error('[Execution Context] Execution killed:', msg.execId);
      } else if (msg.type === 'SERVER_STATE') {
        // Worker reports server state - forward to pending handler
        console.error('[Execution Context] Server state requested');
      } else if (msg.type === 'ASYNC_HANDOVER') {
        // Worker reports async handover - resolve pending execution with current progress
        const { execId, executionInfo } = msg;
        console.error('[Execution Context] Async handover for execution:', execId);

        if (this.pendingExecutions.has(execId)) {
          const { resolve } = this.pendingExecutions.get(execId);
          this.pendingExecutions.delete(execId);

          // Return current progress as successful result
          resolve({
            success: true,
            output: `Execution moved to async mode after 30 seconds.\n\nCurrent progress:\n${executionInfo.currentOutput}\n\n[Execution ID: ${execId} - Use 'action: "get_async_log", executionId: "${execId}"' to view further progress]`,
            isAsyncHandover: true,
            executionId: execId,
            executionInfo
          });
        }
      } else if (msg.type === 'GET_ASYNC_EXECUTION') {
        // Forward async execution request to worker
        this.worker.send(msg);
      } else if (msg.type === 'LIST_ASYNC_EXECUTIONS') {
        // Forward async executions list request to worker
        this.worker.send(msg);
      } else if (msg.type === 'ASYNC_EXECUTION_DATA') {
        // Worker reports async execution data
        console.error('[Execution Context] Async execution data for:', msg.execId);
      } else if (msg.type === 'ASYNC_EXECUTIONS_LIST') {
        // Worker reports async executions list
        console.error('[Execution Context] Async executions list provided');
      } else if (msg.type === 'ASYNC_HISTORY_CLEARED') {
        // Worker reports history cleared
        console.error('[Execution Context] Async history cleared for execution:', msg.execId);
      } else if (msg.type === 'ASYNC_PROGRESS_DATA') {
        // Worker reports progress data
        console.error('[Execution Context] Async progress data for execution:', msg.execId);
      } else if (msg.type === 'HEALTH_STATUS') {
        // Worker reports health status
        console.error('[Execution Context] Health status received');
      } else if (msg.type === 'OPERATION_LOG') {
        // Worker reports operation log
        console.error('[Execution Context] Operation log received');
      } else if (msg.type === 'EXECUTION_REPORT') {
        // Worker reports periodic execution status
        const { report } = msg;
        console.error('[Execution Context] Execution report:', JSON.stringify(report, null, 2));

        // Forward as eager prompt for agent awareness
        // This will be handled by the agent to show execution progress
        if (report.runningExecutions.length > 0 || report.asyncExecutions.length > 0) {
          const summary = [];
          if (report.runningExecutions.length > 0) {
            summary.push(`Running: ${report.runningExecutions.length} execution(s)`);
            report.runningExecutions.forEach(exec => {
              summary.push(`  - ID ${exec.id}: ${exec.duration}s (${exec.outputLines} lines)`);
            });
          }
          if (report.asyncExecutions.length > 0) {
            summary.push(`Async: ${report.asyncExecutions.length} execution(s)`);
            report.asyncExecutions.forEach(exec => {
              summary.push(`  - ID ${exec.id}: ${exec.duration}s (${exec.outputLines} lines)${exec.completed ? ' [COMPLETED]' : ''}`);
            });
          }
          console.error('[Execution Context] Summary:\n' + summary.join('\n'));
        }
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

        if (!tool.inputSchema) {
          throw new Error(`BRUTAL ERROR: tool.inputSchema is undefined for tool ${tool.name} - NO FALLBACKS`);
        }
        if (!tool.inputSchema.properties) {
          throw new Error(`BRUTAL ERROR: tool.inputSchema.properties is undefined for tool ${tool.name} - NO FALLBACKS`);
        }
        const params = tool.inputSchema.properties;
        const required = tool.inputSchema.required || [];
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
` + paramNames.map((p, i) => `    if (${safeParamNames[i]} !== null && ${safeParamNames[i]} !== undefined) args.${p} = ${safeParamNames[i]};`).join('\n') + `
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
  // Handle null, undefined, or empty values - NO FALLBACKS
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('BRUTAL ERROR: filePath is null, undefined, or not a string: ' + filePath + ' - NO FALLBACKS');
  }
  // Check if absolute path (works for both Windows and Unix)
  if (filePath.match(/^([a-zA-Z]:)?[\\\\\\/]/) || filePath.startsWith('/')) return filePath;
  const workingDir = global.__workingDirectory || process.cwd();
  // Simple path joining
  const normalized = filePath.replace(/\\\\/g, '/');
  return workingDir.replace(/\\\\/g, '/') + '/' + normalized;
};

global.TodoWrite = async (todos) => await global.builtInTools.TodoWrite({ todos });
global.LS = async (lsPath, show_hidden, recursive, files_only) => {
  // Map files_only to as_array parameter (built-in tools uses as_array, not files_only)
  const result = await global.builtInTools.LS({ path: resolvePath(lsPath), show_hidden, recursive, as_array: files_only });
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
global.Read = async (file_path, offset, limit) => await global.builtInTools.Read({ file_path: resolvePath(file_path), offset, limit });
global.Write = async (file_path, content) => await global.builtInTools.Write({ file_path: resolvePath(file_path), content });
global.Edit = async (file_path, old_string, new_string, replace_all) => await global.builtInTools.Edit({ file_path: resolvePath(file_path), old_string, new_string, replace_all });
global.Bash = async (command, description, timeout) => await global.builtInTools.Bash({ command, description, timeout });
global.Glob = async (pattern, globPath) => await global.builtInTools.Glob({ pattern, path: resolvePath(globPath) });
global.Grep = async (pattern, grepPath, options) => await global.builtInTools.Grep({ pattern, path: resolvePath(grepPath), ...options });
`;

    return { functions, toolDescriptions };
  }

  async execute(code, workingDirectory) {
    if (!this.worker || !this.initialized) {
      throw new Error('Execution worker not initialized');
    }

    const execId = this.nextId++;

    return new Promise((resolve, reject) => {
      // NO TIMEOUT - executions run until agent manages them
      this.pendingExecutions.set(execId, {
        resolve: (result) => {
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

  sendStdin(execId, data) {
    if (!this.worker || !this.initialized) {
      throw new Error('Execution worker not initialized');
    }

    this.worker.send({
      type: 'STDIN_WRITE',
      execId,
      data
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
      try {
        this.worker.kill('SIGTERM');
        setTimeout(() => {
          if (this.worker && !this.worker.killed) {
            this.worker.kill('SIGKILL');
          }
        }, 1000);
      } catch (error) {}
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
        if (!tool.inputSchema || !tool.inputSchema.properties) {
          throw new Error(`BRUTAL ERROR: tool.inputSchema.properties is undefined for tool ${tool.name} - NO FALLBACKS`);
        }
        const params = Object.keys(tool.inputSchema.properties)
          .map(p => tool.inputSchema.required?.includes(p) ? p : `${p}?`)
          .join(', ');
        mcpToolsList += `- ${serverName}.${tool.name}(${params}): ${tool.description}\n`;
      });
    }
  }

  const description = `Execute JavaScript code with access to all MCP tools. Enhanced with comprehensive validation, monitoring, and error recovery. Both MCP connections and execution context persist across calls - use clear_context() to reset.${mcpToolsList}\n\n**Special Functions:**\n- clear_context(): Clear all variables and state in the execution context\n\n**Enhanced Features:**\n- File content validation after writes\n- JavaScript syntax validation before execution\n- Process health monitoring with automatic retries\n- Tool availability checks with fallback mechanisms\n- Enhanced error handling with recovery suggestions\n- Detailed operation logs with state tracking\n- Progressive build validation with rollback on failures\n\n**Examples:**\n- await builtInTools.Bash('ls -la')\n- await playwright.browser_navigate('https://example.com')\n- await builtInTools.Read('file.txt')`;

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
              description: 'Path to working directory for execution (required when executing code)'
            },
            code: {
              type: 'string',
              description: 'JavaScript code to execute. Context persists between calls. When provided, this will execute code regardless of other parameters.'
            },
            action: {
              type: 'string',
              description: 'Management action. Valid values: "kill", "get_async_log", "list_async_executions", "clear_history", "get_progress", "send_stdin". Used only when no code is provided.'
            },
            executionId: {
              type: 'string',
              description: 'Execution ID for kill, get_async_log, clear_history, get_progress, or send_stdin actions'
            },
            stdinData: {
              type: 'string',
              description: 'Data to send to stdin (used with send_stdin action)'
            },
            clearHistory: {
              type: 'boolean',
              description: 'Clear output history for async execution (used with clear_history action)'
            },
            since: {
              type: 'string',
              description: 'Get progress output since this timestamp (ISO format, used with get_progress action)'
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'execute') {
    try {
      const { action, executionId, code, workingDirectory } = args;

      // Smart execution: If code is provided, always execute code (ignore action)
      if (code) {
        // Normal code execution - ignore any action parameter
        const absWorkingDir = resolve(workingDirectory);
        if (!existsSync(absWorkingDir)) {
          throw new Error(`Working directory does not exist: ${absWorkingDir}`);
        }

        const result = await executionContext.execute(code, absWorkingDir);

        if (result.success) {
          if (!result.output) {
            console.warn('BRUTAL WARNING: result.output is undefined, using success message');
          }
          return {
            content: [{ type: 'text', text: result.output }]
          };
        } else {
          return {
            content: [{ type: 'text', text: result.output }],
            isError: true
          };
        }
      }

      // Handle management actions (only when no code provided)
      if (action) {
        switch (action) {
          case 'kill':
            if (executionContext.worker) {
              executionContext.worker.send({
                type: 'KILL_EXECUTION',
                execId: executionId
              });
              return {
                content: [{ type: 'text', text: `Kill request sent for execution: ${executionId || 'all'}` }]
              };
            } else {
              return {
                content: [{ type: 'text', text: 'Execution context not initialized' }],
                isError: true
              };
            }

          case 'get_async_log':
            if (executionContext.worker && executionId) {
              // Wait for async execution data response
              return new Promise((resolve) => {
                const listener = (msg) => {
                  if (msg.type === 'ASYNC_EXECUTION_DATA' && msg.execId === executionId) {
                    executionContext.worker.removeListener('message', listener);

                    if (msg.error) {
                      resolve({
                        content: [{ type: 'text', text: `Error: ${msg.error}` }],
                        isError: true
                      });
                    } else {
                      const output = msg.data.outputHistory.map(entry =>
                        `[${new Date(entry.timestamp).toISOString()}] ${entry.message}`
                      ).join('\n');

                      resolve({
                        content: [{ type: 'text', text: `Async Execution ${executionId}:\n\n${output}` }]
                      });
                    }
                  }
                };

                executionContext.worker.on('message', listener);
                executionContext.worker.send({
                  type: 'GET_ASYNC_EXECUTION',
                  execId
                });
              });
            } else {
              return {
                content: [{ type: 'text', text: executionId ? 'Execution context not initialized' : 'executionId required for get_async_log' }],
                isError: true
              };
            }

          case 'list_async_executions':
            if (executionContext.worker) {
              // Wait for async executions list response
              return new Promise((resolve) => {
                const listener = (msg) => {
                  if (msg.type === 'ASYNC_EXECUTIONS_LIST') {
                    executionContext.worker.removeListener('message', listener);

                    if (msg.executions.length === 0) {
                      resolve({
                        content: [{ type: 'text', text: 'No async executions currently running' }]
                      });
                    } else {
                      const list = msg.executions.map(exec =>
                        `- Execution ${exec.id}: Started ${new Date(exec.startTime).toISOString()}, Duration: ${Math.round((Date.now() - exec.startTime) / 1000)}s, History entries: ${exec.outputHistoryLength}`
                      ).join('\n');

                      resolve({
                        content: [{ type: 'text', text: `Async Executions (${msg.executions.length}):\n\n${list}` }]
                      });
                    }
                  }
                };

                executionContext.worker.on('message', listener);
                executionContext.worker.send({
                  type: 'LIST_ASYNC_EXECUTIONS'
                });
              });
            } else {
              return {
                content: [{ type: 'text', text: 'Execution context not initialized' }],
                isError: true
              };
            }

          case 'clear_history':
            if (executionContext.worker && executionId) {
              executionContext.worker.send({
                type: 'CLEAR_ASYNC_HISTORY',
                execId,
                clearHistory: args.clearHistory !== false // default to true
              });
              return {
                content: [{ type: 'text', text: `Clearing output history for async execution: ${executionId}` }]
              };
            } else {
              return {
                content: [{ type: 'text', text: executionId ? 'Execution context not initialized' : 'executionId required for clear_history' }],
                isError: true
              };
            }

          case 'get_progress':
            if (executionContext.worker && executionId) {
              // Wait for async progress data response
              return new Promise((resolve) => {
                const listener = (msg) => {
                  if (msg.type === 'ASYNC_PROGRESS_DATA' && msg.execId === executionId) {
                    executionContext.worker.removeListener('message', listener);

                    if (msg.error) {
                      resolve({
                        content: [{ type: 'text', text: `Error: ${msg.error}` }],
                        isError: true
                      });
                    } else {
                      resolve({
                        content: [{ type: 'text', text: `Progress for Execution ${executionId} (${msg.totalEntries} entries):\n\n${msg.progress}` }]
                      });
                    }
                  }
                };

                executionContext.worker.on('message', listener);
                executionContext.worker.send({
                  type: 'GET_ASYNC_PROGRESS',
                  execId,
                  since: args.since
                });
              });
            } else {
              return {
                content: [{ type: 'text', text: executionId ? 'Execution context not initialized' : 'executionId required for get_progress' }],
                isError: true
              };
            }

          case 'send_stdin':
            if (executionContext && executionId && args.stdinData !== undefined) {
              executionContext.sendStdin(executionId, args.stdinData);
              return {
                content: [{ type: 'text', text: `Stdin data sent to execution ${executionId}` }]
              };
            } else {
              return {
                content: [{ type: 'text', text: 'executionId and stdinData required for send_stdin' }],
                isError: true
              };
            }

          default:
            return {
              content: [{ type: 'text', text: `Unknown action: ${action}` }],
              isError: true
            };
        }
      }

      // No code and no action provided - helpful error message
      return {
        content: [{ type: 'text', text: 'No code provided. Either provide code to execute, or use an action parameter for management tasks.' }],
        isError: true
      };
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
  const { config, configDir } = loadConfig();

  // Initialize persistent MCP servers - NO FALLBACKS
  try {
    await mcpManager.initialize(config, configDir);
    console.error('[Execute Server] MCP servers initialized successfully');
  } catch (error) {
    console.error('BRUTAL ERROR: MCP server initialization failed - NO FALLBACK MODE:', error.message);
    console.error('BRUTAL ERROR: System cannot continue without MCP servers');
    throw new Error(`BRUTAL ERROR: MCP server initialization failed - NO FALLBACKS: ${error.message}`);
  }

  // Initialize persistent execution context - NO FALLBACKS
  try {
    executionContext = new ExecutionContextManager(mcpManager);
    await executionContext.initialize();
    console.error('[Execute Server] Execution context initialized successfully');
  } catch (error) {
    console.error('BRUTAL ERROR: Execution context initialization failed - NO FALLBACKS:', error.message);
    console.error('BRUTAL ERROR: System cannot continue without execution context');
    throw new Error(`BRUTAL ERROR: Execution context initialization failed - NO FALLBACKS: ${error.message}`);
  }

  // Handle shutdown
  const shutdown = () => {
    console.error('[Execute Server] Shutting down...');
    if (executionContext) {
      executionContext.shutdown();
    }
    mcpManager.shutdown();
    setTimeout(() => {
      process.exit(0);
    }, 1500);
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
