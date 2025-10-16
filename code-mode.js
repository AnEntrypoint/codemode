#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  chmodSync,
} from 'fs';
import { join, resolve, dirname, basename, delimiter } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import fg from 'fast-glob';
import { generateMCPFunctions } from './generate-mcp-functions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const backgroundExecutions = new Map();
const MAX_BACKGROUND_EXECUTIONS = 20;
const ASYNC_THRESHOLD_MS = 30000;

class BackgroundExecution {
  constructor(id, process, code, runtime, workingDirectory, tempFiles = []) {
    this.id = id;
    this.process = process;
    this.code = code;
    this.runtime = runtime;
    this.workingDirectory = workingDirectory;
    this.tempFiles = tempFiles;
    this.stdout = '';
    this.stderr = '';
    this.startTime = Date.now();
    this.endTime = null;
    this.exitCode = null;
    this.status = 'running';
    this.lastReadPosition = 0;

    // Unref streams so Node.js doesn't wait for them
    this.process.stdout?.unref();
    this.process.stderr?.unref();

    this.process.stdout?.on('data', (data) => {
      this.stdout += data.toString();
    });

    this.process.stderr?.on('data', (data) => {
      this.stderr += data.toString();
    });

    this.process.on('close', (code) => {
      this.status = 'completed';
      this.exitCode = code;
      this.endTime = Date.now();

      // Clean up temp files after process completes
      this.cleanupTempFiles();

      setTimeout(() => {
        backgroundExecutions.delete(id);
      }, 300000);
    });

    this.process.on('error', (error) => {
      this.status = 'failed';
      this.stderr += `\nProcess error: ${error.message}`;
      this.endTime = Date.now();

      // Clean up temp files on error
      this.cleanupTempFiles();
    });
  }

  cleanupTempFiles() {
    for (const file of this.tempFiles) {
      try {
        unlinkSync(file);
      } catch (e) {
        // File may already be deleted or not exist
      }
    }
  }

  getNewOutput() {
    const output = this.stdout + this.stderr;
    const newOutput = output.substring(this.lastReadPosition);
    this.lastReadPosition = output.length;
    return newOutput;
  }

  getAllOutput() {
    return this.stdout + this.stderr;
  }

  kill() {
    if (this.process && this.status === 'running') {
      this.process.kill('SIGTERM');
      this.status = 'killed';
      this.endTime = Date.now();
    }
  }

  getInfo() {
    const runningTimeMs = (this.endTime || Date.now()) - this.startTime;
    return {
      id: this.id,
      status: this.status,
      runtime: this.runtime,
      workingDirectory: this.workingDirectory,
      startTime: this.startTime,
      runningTimeMs,
      exitCode: this.exitCode
    };
  }
}

function getAvailableExecutionId() {
  if (backgroundExecutions.size >= MAX_BACKGROUND_EXECUTIONS) {
    throw new Error(`Maximum ${MAX_BACKGROUND_EXECUTIONS} background executions already running`);
  }

  for (let i = 1; i <= MAX_BACKGROUND_EXECUTIONS; i++) {
    const id = i.toString().padStart(6, '0');
    if (!backgroundExecutions.has(id)) {
      return id;
    }
  }
  throw new Error('No available execution IDs');
}

function validateWorkingDirectory(workingDir) {
  if (!workingDir) {
    return {
      isValid: false,
      error: 'Working directory is required'
    };
  }

  const resolvedDir = resolve(workingDir);

  if (!existsSync(resolvedDir)) {
    return {
      isValid: false,
      error: `Working directory does not exist: ${resolvedDir}`
    };
  }

  return { isValid: true, resolvedDir, effectiveDir: resolvedDir };
}

function createToolsModule(workingDirectory, nodePath) {
  return `
const { spawn } = require('child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } = require('fs');
const { join, resolve, dirname, basename } = require('path');
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent) {
  if (request === 'fast-glob') {
    return '${nodePath}/node_modules/fast-glob/out/index.js';
  }
  return originalResolve.apply(this, arguments);
};
const fg = require('fast-glob');

const Read = (file_path, offset, limit) => {
  const absPath = resolve('${workingDirectory}', file_path);
  if (!existsSync(absPath)) {
    throw new Error(\`File not found: \${absPath}\`);
  }
  let content = readFileSync(absPath, 'utf8');
  if (content === '') {
    return \`<system-reminder>File exists but has empty contents: \${absPath}</system-reminder>\`;
  }
  const lines = content.split('\\n');
  const start = offset || 0;
  const defaultLimit = 2000;
  const end = limit ? start + limit : Math.min(start + defaultLimit, lines.length);
  const selectedLines = lines.slice(start, end);
  const numberedLines = selectedLines.map((line, index) => {
    const lineNum = start + index + 1;
    const truncatedLine = line.length > 2000 ? line.substring(0, 2000) : line;
    return \`\${lineNum.toString().padStart(5)}→\${truncatedLine}\`;
  });
  let result = numberedLines.join('\\n');
  if (result.length > 30000) {
    result = result.substring(0, 30000);
  }
  return result;
};

const Write = (file_path, content) => {
  const absPath = resolve('${workingDirectory}', file_path);
  const fileExists = existsSync(absPath);
  if (fileExists) {
    const existingContent = readFileSync(absPath, 'utf8');
    if (existingContent === content) {
      return \`File unchanged: \${absPath} (content is identical)\`;
    }
  }
  const dir = dirname(absPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(absPath, content, 'utf8');
  const action = fileExists ? 'overwrote' : 'created';
  return \`Successfully \${action} file: \${absPath}\`;
};

const Edit = (file_path, old_string, new_string, replace_all = false) => {
  const absPath = resolve('${workingDirectory}', file_path);
  if (!existsSync(absPath)) {
    throw new Error(\`File not found: \${absPath}\`);
  }
  if (old_string === new_string) {
    return 'No changes made: old_string and new_string are identical';
  }
  let content = readFileSync(absPath, 'utf8');
  const originalContent = content;
  if (replace_all) {
    if (!content.includes(old_string)) {
      throw new Error(\`String not found in file: \${old_string}\`);
    }
    content = content.split(old_string).join(new_string);
  } else {
    const index = content.indexOf(old_string);
    if (index === -1) {
      throw new Error(\`String not found in file: \${old_string}\`);
    }
    content = content.substring(0, index) + new_string + content.substring(index + old_string.length);
  }
  if (content !== originalContent) {
    writeFileSync(absPath, content, 'utf8');
  }
  const action = replace_all ? 'replaced all occurrences' : 'replaced';
  return \`Successfully \${action} in file: \${absPath}\`;
};

const Glob = async (pattern, path) => {
  const cwd = path ? resolve('${workingDirectory}', path) : '${workingDirectory}';
  const files = await fg(pattern, {
    cwd,
    absolute: false,
    dot: true,
    onlyFiles: true,
    stats: true
  });
  const sortedFiles = files
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
    .map(entry => typeof entry === 'string' ? entry : entry.path);
  let result = sortedFiles.length > 0 ? sortedFiles.join('\\n') : 'No files matched';
  if (result.length > 30000) {
    result = result.substring(0, 30000);
  }
  return result;
};

const Grep = (pattern, path = '.', options = {}) => {
  return new Promise((resolve, reject) => {
    const searchPath = require('path').resolve('${workingDirectory}', path);
    const rgArgs = [pattern, searchPath];
    if (options.glob) rgArgs.push('--glob', options.glob);
    if (options.type) rgArgs.push('--type', options.type);
    if (options['-i']) rgArgs.push('--ignore-case');
    if (options['-n']) rgArgs.push('--line-number');
    if (options.multiline) rgArgs.push('--multiline');
    if (options['-B']) rgArgs.push('--before-context', options['-B'].toString());
    if (options['-A']) rgArgs.push('--after-context', options['-A'].toString());
    if (options['-C']) rgArgs.push('--context', options['-C'].toString());
    const output_mode = options.output_mode || 'files_with_matches';
    if (output_mode === 'files_with_matches') {
      rgArgs.push('--files-with-matches');
    } else if (output_mode === 'count') {
      rgArgs.push('--count');
    }
    const child = spawn('rg', rgArgs);
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { errorOutput += data.toString(); });
    child.on('close', (code) => {
      if (code !== 0 && errorOutput && !errorOutput.includes('No matches found')) {
        reject(new Error(\`Grep search error: \${errorOutput}\`));
        return;
      }
      let result = output.trim();
      if (options.head_limit) {
        const lines = result.split('\\n');
        result = lines.slice(0, options.head_limit).join('\\n');
      }
      if (result.length > 30000) {
        result = result.substring(0, 30000);
      }
      resolve(result || 'No matches found');
    });
  });
};

const Bash = (command, description, timeout = 120000) => {
  return new Promise((resolve, reject) => {
    if (timeout > 600000) {
      reject(new Error('Timeout cannot exceed 600000ms (10 minutes)'));
      return;
    }
    if (command.includes('rm -rf /') || command.includes('sudo rm')) {
      reject(new Error('Dangerous command detected'));
      return;
    }
    const child = spawn(command, [], {
      shell: true,
      timeout,
      cwd: '${workingDirectory}',
      env: { ...process.env, TERM: 'xterm-256color' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      let output = stdout || stderr;
      const prefix = description ? \`[\${description}] \` : '';
      if (output.length > 30000) {
        output = output.substring(0, 30000);
      }
      if (code === 0) {
        resolve(\`\${prefix}\${output}\`);
      } else {
        reject(new Error(\`\${prefix}\${output}\`));
      }
    });
    child.on('error', (error) => {
      reject(new Error(\`Command execution error: \${error.message}\`));
    });
  });
};

const LS = (path = '.', show_hidden = false, recursive = false) => {
  const absPath = resolve('${workingDirectory}', path);
  if (!existsSync(absPath)) {
    throw new Error(\`Path not found: \${absPath}\`);
  }
  const stats = statSync(absPath);
  if (!stats.isDirectory()) {
    return \`\${basename(absPath)} (\${stats.size} bytes)\`;
  }
  function listDirectory(dirPath, prefix = '') {
    const entries = readdirSync(dirPath);
    const result = [];
    for (const entry of entries) {
      if (!show_hidden && entry.startsWith('.')) {
        continue;
      }
      const fullPath = join(dirPath, entry);
      const stats = statSync(fullPath);
      const isDir = stats.isDirectory();
      const size = isDir ? '' : \` (\${stats.size} bytes)\`;
      const type = isDir ? '/' : '';
      result.push(\`\${prefix}\${entry}\${type}\${size}\`);
      if (recursive && isDir) {
        result.push(...listDirectory(fullPath, prefix + '  '));
      }
    }
    return result;
  }
  const listing = listDirectory(absPath);
  let result = listing.length > 0 ? listing.join('\\n') : 'Empty directory';
  if (result.length > 30000) {
    result = result.substring(0, 30000);
  }
  return result;
};

module.exports = { Read, Write, Edit, Glob, Grep, Bash, LS };
`;
}

async function executeProcessAsync(command, args = [], options = {}) {
  const startTime = Date.now();
  const { timeout = 240000, cwd, encoding = 'utf8', asyncThreshold = ASYNC_THRESHOLD_MS, trackingInfo = {}, stdin } = options;

  const toolsDir = join(__dirname, 'tools');
  const enhancedEnv = {
    ...process.env,
    CODEMODE_WORKING_DIR: cwd || process.cwd(),
    PATH: `${toolsDir}${delimiter}${process.env.PATH || ''}`,
    CODEMODE_TOOL_PATH: join(toolsDir, 'codemode-tool')
  };

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: enhancedEnv
    });

    // Write stdin if provided and close the stream
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    let stdout = '';
    let stderr = '';
    let isResolved = false;
    let backgroundExecution = null;

    const asyncThresholdId = setTimeout(() => {
      if (!isResolved && !backgroundExecution) {
        const executionId = getAvailableExecutionId();

        // Detach child process from parent event loop so Node.js doesn't wait for it
        child.unref();

        backgroundExecution = new BackgroundExecution(
          executionId,
          child,
          trackingInfo.code || '',
          trackingInfo.runtime || 'unknown',
          trackingInfo.workingDirectory || cwd,
          trackingInfo.tempFiles || []
        );
        backgroundExecution.stdout = stdout;
        backgroundExecution.stderr = stderr;
        backgroundExecutions.set(executionId, backgroundExecution);

        isResolved = true;
        const currentOutput = stdout + stderr;
        const truncatedOutput = currentOutput.length > 30000 ? currentOutput.substring(0, 30000) : currentOutput;

        resolve({
          success: true,
          async: true,
          executionId,
          stdout: truncatedOutput,
          stderr: '',
          partialOutput: true,
          message: `Execution running in background (ID: ${executionId}). Use execute_output tool to retrieve results.`,
          executionTimeMs: Date.now() - startTime
        });
      }
    }, asyncThreshold);

    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        child.kill('SIGTERM');
        clearTimeout(asyncThresholdId);
        isResolved = true;
        resolve({
          success: false,
          error: `Execution timed out after ${timeout}ms`,
          executionTimeMs: Date.now() - startTime
        });
      }
    }, timeout);

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString(encoding);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString(encoding);
      });
    }

    child.on('close', (code) => {
      if (!isResolved) {
        clearTimeout(timeoutId);
        clearTimeout(asyncThresholdId);
        isResolved = true;

        if (code === 0) {
          resolve({
            success: true,
            stdout,
            stderr,
            code,
            executionTimeMs: Date.now() - startTime
          });
        } else {
          resolve({
            success: false,
            stdout,
            stderr,
            code,
            error: stderr || `Process exited with code ${code}`,
            executionTimeMs: Date.now() - startTime
          });
        }
      }
    });

    child.on('error', (error) => {
      if (!isResolved) {
        clearTimeout(timeoutId);
        clearTimeout(asyncThresholdId);
        isResolved = true;
        resolve({
          success: false,
          error: error.message,
          executionTimeMs: Date.now() - startTime
        });
      }
    });
  });
}

const EXECUTION_CONFIGS = {
  nodejs: { command: 'node', args: ['-e'], description: 'Node.js JavaScript' },
  deno: { command: 'deno', args: ['eval', '--no-check'], description: 'Deno JavaScript/TypeScript' },
  bash: { command: 'bash', args: ['-c'], description: 'Bash shell commands' },
  go: { command: 'go', args: ['run'], description: 'Go programming language', requiresFile: true },
  rust: { command: 'rustc', args: [], description: 'Rust programming language', requiresCompile: true },
  python: { command: 'python3', args: ['-c'], description: 'Python programming language' },
  c: { command: 'gcc', args: [], description: 'C programming language', requiresCompile: true },
  cpp: { command: 'g++', args: [], description: 'C++ programming language', requiresCompile: true }
};

async function executeWithRuntime(codeOrCommands, runtime, options = {}) {
  const { workingDirectory, timeout = 240000, trackingInfo = {} } = options;
  const config = EXECUTION_CONFIGS[runtime];

  if (!config) {
    throw new Error(`Unsupported runtime: ${runtime}`);
  }

  if (runtime === 'bash') {
    if (Array.isArray(codeOrCommands)) {
      const script = codeOrCommands.join('\n');
      return executeProcessAsync(config.command, [...config.args, script], {
        cwd: workingDirectory,
        timeout,
        trackingInfo: { ...trackingInfo, code: script, runtime }
      });
    } else {
      return executeProcessAsync(config.command, [...config.args, codeOrCommands], {
        cwd: workingDirectory,
        timeout,
        trackingInfo: { ...trackingInfo, code: codeOrCommands, runtime }
      });
    }
  }

  if (config.requiresFile) {
    const tempFile = join(tmpdir(), `codemode_${runtime}_${Date.now()}.${runtime === 'go' ? 'go' : 'rs'}`);
    try {
      writeFileSync(tempFile, codeOrCommands);
      return await executeProcessAsync(config.command, [...config.args, tempFile], {
        cwd: workingDirectory,
        timeout,
        trackingInfo: { ...trackingInfo, code: codeOrCommands, runtime }
      });
    } finally {
      try { unlinkSync(tempFile); } catch (e) {}
    }
  }

  if (config.requiresCompile) {
    const extensions = { rust: 'rs', c: 'c', cpp: 'cpp' };
    const compilers = { rust: 'rustc', c: 'gcc', cpp: 'g++' };

    const tempFile = join(tmpdir(), `codemode_${runtime}_${Date.now()}.${extensions[runtime]}`);
    const tempExec = join(tmpdir(), `codemode_${runtime}_${Date.now()}`);

    try {
      writeFileSync(tempFile, codeOrCommands);

      const compileResult = await executeProcessAsync(compilers[runtime], [tempFile, '-o', tempExec], {
        cwd: workingDirectory,
        timeout: timeout / 2,
        trackingInfo: { ...trackingInfo, code: codeOrCommands, runtime: `${runtime}-compile` }
      });

      if (!compileResult.success) {
        return compileResult;
      }

      return await executeProcessAsync(tempExec, [], {
        cwd: workingDirectory,
        timeout: timeout / 2,
        trackingInfo: { ...trackingInfo, code: codeOrCommands, runtime }
      });
    } finally {
      try { unlinkSync(tempFile); } catch (e) {}
      try { unlinkSync(tempExec); } catch (e) {}
    }
  }

  return executeProcessAsync(config.command, [...config.args, codeOrCommands], {
    cwd: workingDirectory,
    timeout,
    trackingInfo: { ...trackingInfo, code: codeOrCommands, runtime }
  });
}

async function generateExecuteDescription() {
  try {
    const { description, count } = await generateMCPFunctions('codeMode');

    return `Execute JavaScript code with embedded file system functions and MCP tools. Returns immediately if execution completes within 30 seconds. For longer executions, returns partial output and execution ID for later querying.

Available functions (${count} total):
${description}

Also includes built-in functions: Read(path, offset, limit), Write(path, content), Edit(path, old, new, replace_all), Glob(pattern, path), Grep(pattern, path, options), Bash(command, desc, timeout), LS(path, show_hidden, recursive)`;
  } catch (error) {
    console.error('Failed to generate MCP functions:', error.message);
    return 'Execute JavaScript code with embedded file system functions. Available functions: Read(path, offset, limit), Write(path, content), Edit(path, old, new, replace_all), Glob(pattern, path), Grep(pattern, path, options), Bash(command, desc, timeout), LS(path, show_hidden, recursive)';
  }
}

async function executeCode(code, workingDirectory, runtime = 'auto', timeout = 240000, serverDir) {
  let targetRuntime = runtime === 'auto' ? 'nodejs' : runtime;

  const toolsModule = createToolsModule(workingDirectory, serverDir);

  // Generate MCP functions for this execution (excluding self to avoid recursion)
  let mcpFunctions = '';
  try {
    const { functions } = await generateMCPFunctions('codeMode');
    mcpFunctions = functions;
  } catch (error) {
    console.error('Failed to generate MCP functions:', error.message);
    mcpFunctions = '// MCP functions not available';
  }

  // Inline the entire tools module and MCP functions, then wrap the user code
  // Use stdin to pass code, avoiding temp files and command line length limits
  const wrappedCode = `
${toolsModule}

// Generated MCP Functions
${mcpFunctions}

// User code runs here with access to all tool functions and MCP functions
// They're already available in scope from the modules above
(async () => {
  ${code}
})().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
`;

  const result = await executeProcessAsync('node', [], {
    cwd: workingDirectory,
    timeout,
    stdin: wrappedCode,
    trackingInfo: {
      code,
      runtime: targetRuntime,
      workingDirectory,
      tempFiles: []
    }
  });

  return result;
}

const server = new Server(
  {
    name: 'claude-code-mode',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'execute',
        description: await generateExecuteDescription(),
        inputSchema: {
          type: 'object',
          properties: {
            workingDirectory: {
              type: 'string',
              description: 'Path to working directory for execution'
            },
            code: {
              type: 'string',
              description: 'JavaScript code to execute with embedded functions available'
            },
            runtime: {
              type: 'string',
              enum: ['nodejs', 'deno', 'auto'],
              description: 'Execution runtime (default: nodejs)'
            },
            timeout: {
              type: 'number',
              description: 'Maximum execution time in milliseconds (default: 240000)'
            }
          },
          required: ['workingDirectory', 'code']
        }
      },
      {
        name: 'execute_output',
        description: 'Retrieve output from a background execution by ID. Returns new output since last check or all output if first check.',
        inputSchema: {
          type: 'object',
          properties: {
            executionId: {
              type: 'string',
              description: 'Execution ID returned from execute tool'
            },
            getAll: {
              type: 'boolean',
              description: 'Get all output instead of just new output (default: false)'
            }
          },
          required: ['executionId']
        }
      },
      {
        name: 'execute_list',
        description: 'List all running and recently completed background executions with their status and metadata.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'execute_kill',
        description: 'Kill a running background execution by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            executionId: {
              type: 'string',
              description: 'Execution ID to kill'
            }
          },
          required: ['executionId']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'execute') {
      const { code, workingDirectory, runtime = 'nodejs', timeout = 240000 } = args;

      if (!code) {
        throw new Error('code parameter is required');
      }

      if (!workingDirectory) {
        throw new Error('workingDirectory parameter is required');
      }

      const dirValidation = validateWorkingDirectory(workingDirectory);
      if (!dirValidation.isValid) {
        throw new Error(dirValidation.error);
      }

      const effectiveWorkingDir = dirValidation.resolvedDir;
      const result = await executeCode(code, effectiveWorkingDir, runtime, timeout, __dirname);

      if (result.async) {
        let message = `${result.message}\n\n`;
        message += `Status: Background execution started\n`;
        message += `Execution ID: ${result.executionId}\n`;
        message += `Running time: ${result.executionTimeMs}ms\n\n`;
        message += `Partial output so far:\n${result.stdout}`;

        if (message.length > 30000) {
          message = message.substring(0, 30000);
        }

        return {
          content: [{
            type: 'text',
            text: message
          }]
        };
      }

      let output = result.stdout || result.stderr || '';
      if (output.length > 30000) {
        output = output.substring(0, 30000);
      }

      return {
        content: [{
          type: 'text',
          text: output
        }]
      };

    } else if (name === 'execute_output') {
      const { executionId, getAll = false } = args;

      const execution = backgroundExecutions.get(executionId);
      if (!execution) {
        throw new Error(`Execution ID not found: ${executionId}`);
      }

      const info = execution.getInfo();
      const output = getAll ? execution.getAllOutput() : execution.getNewOutput();

      let message = `Execution ID: ${executionId}\n`;
      message += `Status: ${info.status}\n`;
      message += `Runtime: ${info.runtime}\n`;
      message += `Running time: ${info.runningTimeMs}ms\n`;
      if (info.exitCode !== null) {
        message += `Exit code: ${info.exitCode}\n`;
      }
      message += `\nOutput:\n${output}`;

      if (message.length > 30000) {
        message = message.substring(0, 30000);
      }

      return {
        content: [{
          type: 'text',
          text: message
        }]
      };

    } else if (name === 'execute_list') {
      if (backgroundExecutions.size === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No background executions running or recently completed'
          }]
        };
      }

      let message = `Background Executions (${backgroundExecutions.size}):\n\n`;
      for (const [id, execution] of backgroundExecutions.entries()) {
        const info = execution.getInfo();
        message += `ID: ${id}\n`;
        message += `  Status: ${info.status}\n`;
        message += `  Runtime: ${info.runtime}\n`;
        message += `  Running time: ${info.runningTimeMs}ms\n`;
        message += `  Working directory: ${info.workingDirectory}\n`;
        if (info.exitCode !== null) {
          message += `  Exit code: ${info.exitCode}\n`;
        }
        message += `\n`;
      }

      if (message.length > 30000) {
        message = message.substring(0, 30000);
      }

      return {
        content: [{
          type: 'text',
          text: message
        }]
      };

    } else if (name === 'execute_kill') {
      const { executionId } = args;

      const execution = backgroundExecutions.get(executionId);
      if (!execution) {
        throw new Error(`Execution ID not found: ${executionId}`);
      }

      if (execution.status !== 'running') {
        throw new Error(`Execution ${executionId} is not running (status: ${execution.status})`);
      }

      execution.kill();

      return {
        content: [{
          type: 'text',
          text: `Execution ${executionId} killed successfully`
        }]
      };

    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Claude Code Mode MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
