#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve, dirname, basename, delimiter } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import fg from 'fast-glob';

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

function getBuiltInToolSchemas() {
  return [
    {
      name: 'Read',
      description: 'Read file content from the filesystem. Returns file contents with line numbers. Supports reading specific ranges with offset and limit parameters.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to read (relative to working directory)' },
          offset: { type: 'number', description: 'Line number to start reading from (optional)' },
          limit: { type: 'number', description: 'Number of lines to read (optional, default 2000)' }
        },
        required: ['file_path']
      }
    },
    {
      name: 'Write',
      description: 'Write content to a file, creating it if it doesn\'t exist or overwriting if it does. Creates parent directories as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Content to write to the file' }
        },
        required: ['file_path', 'content']
      }
    },
    {
      name: 'Edit',
      description: 'Edit a file by replacing exact string matches. Can replace first occurrence or all occurrences.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to edit' },
          old_string: { type: 'string', description: 'String to find and replace' },
          new_string: { type: 'string', description: 'String to replace with' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    },
    {
      name: 'Glob',
      description: 'Find files matching a glob pattern. Returns sorted list of matching files.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts")' },
          path: { type: 'string', description: 'Directory to search in (optional, defaults to working directory)' }
        },
        required: ['pattern']
      }
    },
    {
      name: 'Grep',
      description: 'Search for patterns in files using ripgrep. Supports regex patterns, file filtering, and various output modes.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression pattern to search for' },
          path: { type: 'string', description: 'File or directory to search (default: current directory)' },
          options: {
            type: 'object',
            description: 'Search options: {glob, type, output_mode, "-i", "-n", "-A", "-B", "-C", multiline, head_limit}',
            properties: {
              glob: { type: 'string', description: 'File filter pattern' },
              type: { type: 'string', description: 'File type (js, py, rust, etc)' },
              output_mode: { type: 'string', description: '"content", "files_with_matches", or "count"' },
              '-i': { type: 'boolean', description: 'Case insensitive' },
              '-n': { type: 'boolean', description: 'Show line numbers' },
              '-A': { type: 'number', description: 'Lines of context after' },
              '-B': { type: 'number', description: 'Lines of context before' },
              '-C': { type: 'number', description: 'Lines of context around' },
              multiline: { type: 'boolean', description: 'Enable multiline matching' },
              head_limit: { type: 'number', description: 'Limit output lines' }
            }
          }
        },
        required: ['pattern']
      }
    },
    {
      name: 'Bash',
      description: 'Execute shell commands. Supports timeout and captures both stdout and stderr.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          description: { type: 'string', description: 'Description of what the command does (optional)' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (max 600000, default 120000)' }
        },
        required: ['command']
      }
    },
    {
      name: 'LS',
      description: 'List directory contents with file sizes. Supports hidden files and recursive listing.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list (default: current directory)' },
          show_hidden: { type: 'boolean', description: 'Show hidden files (default: false)' },
          recursive: { type: 'boolean', description: 'List recursively (default: false)' }
        },
        required: []
      }
    },
    {
      name: 'TodoWrite',
      description: 'Write todo list to console for task tracking.',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'Array of todo items with {content, status, activeForm}',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                activeForm: { type: 'string' }
              }
            }
          }
        },
        required: ['todos']
      }
    }
  ];
}

function createToolsModule(workingDirectory) {
  return `
const { spawn } = require('child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } = require('fs');
const { join, resolve, dirname, basename } = require('path');

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
  const Module = require('module');
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function(request, parent) {
    if (request === 'fast-glob') {
      return '${__dirname}/node_modules/fast-glob/out/index.js';
    }
    return originalResolve.apply(this, arguments);
  };
  const fg = require('fast-glob');

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

const WebFetch = async (url, prompt) => {
  throw new Error('WebFetch not implemented in execute context');
};

const WebSearch = async (query, allowed_domains, blocked_domains) => {
  throw new Error('WebSearch not implemented in execute context');
};

const TodoWrite = async (todos) => {
  console.log('TodoWrite:', JSON.stringify(todos, null, 2));
  return 'TodoWrite logged to console';
};

const Task = async (description, prompt, subagent_type) => {
  throw new Error('Task not implemented in execute context');
};

module.exports = { Read, Write, Edit, Glob, Grep, Bash, LS, WebFetch, WebSearch, TodoWrite, Task };
`;
}

async function generateMCPFunctions() {
  const config = loadConfig();
  let functions = '';
  const toolDescriptions = {};

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    if (serverName === 'codeMode') continue;

    try {
      console.error(`[MCP] Connecting to ${serverName}...`);

      const process = spawn(serverConfig.command, serverConfig.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: __dirname
      });

      let buffer = '';
      const tools = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          process.kill();
          reject(new Error(`Timeout connecting to ${serverName}`));
        }, 30000);

        process.stdout.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.trim()) {
              try {
                const response = JSON.parse(line);
                if (response.id === 1) {
                  clearTimeout(timeout);
                  process.kill();
                  resolve(response.result?.tools || []);
                }
              } catch (e) {}
            }
          }
        });

        process.stderr.on('data', () => {});

        process.on('close', () => {
          clearTimeout(timeout);
        });

        process.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list'
        }) + '\n');
      });

      if (!toolDescriptions[serverName]) {
        toolDescriptions[serverName] = [];
      }

      console.error(`[MCP] ✓ ${serverName}: Loaded ${tools.length} tool(s)`);

      for (const tool of tools) {
        toolDescriptions[serverName].push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        });
        console.error(`[MCP]    - ${tool.name}`);

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
            return `  if (${safeName} === null) throw new Error('Missing required parameter: ${p}');`;
          }).join('\n');
        }

        const argsObject = paramNames.map((p, i) => `${p}: ${safeParamNames[i]}`).join(', ');

        functions += `
${signature} {
${validation ? validation + '\n' : ''}  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('${serverConfig.command}', ${JSON.stringify(serverConfig.args)}, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', () => {});

    proc.on('close', (code) => {
      const lines = output.split('\\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            if (response.id === 1) {
              if (response.error) {
                reject(new Error(response.error.message));
              } else {
                const content = response.result?.content;
                if (Array.isArray(content) && content[0]?.type === 'text') {
                  resolve(content[0].text);
                } else {
                  resolve(JSON.stringify(response.result));
                }
              }
              return;
            }
          } catch (e) {}
        }
      }
      reject(new Error('No valid response from MCP server'));
    });

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: '${tool.name}',
        arguments: { ${argsObject} }
      }
    }) + '\\n');
  });
}

`;
      }

    } catch (error) {
      console.error(`[MCP] ✗ ${serverName}: Failed to load - ${error.message}`);
    }
  }

  console.error(`[MCP] Total tools loaded: ${Object.values(toolDescriptions).reduce((sum, tools) => sum + tools.length, 0)}`);
  console.error('');

  return { functions, toolDescriptions };
}

async function executeCode(code, workingDirectory) {
  const toolsModule = createToolsModule(workingDirectory);
  const { functions: mcpFunctions } = await generateMCPFunctions();

  const wrappedCode = `
${toolsModule}

${mcpFunctions}

(async () => {
  ${code}
})().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
`;

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workingDirectory
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, error: stderr || stdout });
      }
    });

    proc.stdin.write(wrappedCode);
    proc.stdin.end();
  });
}

const server = new Server(
  {
    name: 'codemode-execute',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { toolDescriptions } = await generateMCPFunctions();
  const builtInTools = getBuiltInToolSchemas();

  let builtInToolsList = '\n## Built-in Functions:\n';
  builtInTools.forEach(tool => {
    const params = Object.keys(tool.inputSchema?.properties || {})
      .map(p => tool.inputSchema.required?.includes(p) ? p : `${p}?`)
      .join(', ');
    builtInToolsList += `- ${tool.name}(${params}): ${tool.description}\n`;
  });

  let mcpToolsList = '';
  if (Object.keys(toolDescriptions).length > 0) {
    mcpToolsList = '\n\n## MCP Tools by Server:\n';
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

  const description = `Execute JavaScript code with access to file operations, system commands, and MCP tools from configured servers.${builtInToolsList}${mcpToolsList}`;

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
              description: 'JavaScript code to execute with embedded functions available'
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
      content: [{
        type: 'text',
        text: `Unknown tool: ${name}`
      }],
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

    const result = await executeCode(code, absWorkingDir);

    if (result.success) {
      return {
        content: [{
          type: 'text',
          text: result.output || 'Code executed successfully'
        }]
      };
    } else {
      return {
        content: [{
          type: 'text',
          text: `Error: ${result.error}`
        }],
        isError: true
      };
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
  console.error('CodeMode Execute MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
