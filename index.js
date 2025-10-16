#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  renameSync
} from 'fs';
import { join, resolve, dirname, basename, extname, relative } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import fg from 'fast-glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Claude's contextual instructions - CRITICAL for behavioral compatibility
const CLAUDE_CONTEXT_INSTRUCTIONS = `
# Claude Code Instructions

## Tone and style
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- Your output will be displayed on a command line interface. Your responses should be short and concise. You can use Github-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
- Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like Bash or code comments as means to communicate with the user during the session.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one. This includes markdown files.

## Professional objectivity
Prioritize technical accuracy and truthfulness over validating the user's beliefs. Focus on facts and problem-solving, providing direct, objective technical info without any unnecessary superlatives, praise, or emotional validation. It is best for the user if Claude honestly applies the same rigorous standards to all ideas and disagrees when necessary, even if it may not be what the user wants to hear. Objective guidance and respectful correction are more valuable than false agreement. Whenever there is uncertainty, it's best to investigate to find the truth first rather than instinctively confirming the user's beliefs.

## Task Management
You have access to the TodoWrite tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.

It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.

Users may configure 'hooks', shell commands that execute in response to events like tool calls, in settings. Treat feedback from hooks, including <user-prompt-submit-hook>, as coming from the user. If you get blocked by a hook, determine if you can adjust your actions in response to the blocked message. If not, ask the user to check their hooks configuration.

## Doing tasks
The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:

- Use the TodoWrite tool to plan the task if required

- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear.

## Tool usage policy
- When doing file search, prefer to use the Task tool in order to reduce context usage.
- You should proactively use the Task tool with specialized agents when the task at hand matches the agent's description.
- When WebFetch returns a message about a redirect to a different host, you should immediately make a new WebFetch request with the redirect URL provided in the response.
- You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially. For instance, if one operation must complete before another starts, run these operations sequentially instead. Never use placeholders or guess missing parameters in tool calls.
- Use specialized tools instead of bash commands when possible, as this provides a better user experience. For file operations, use dedicated tools: Read for reading files instead of cat/head/tail, Edit for editing instead of sed/awk, and Write for creating files instead of cat with heredoc or echo redirection. Reserve bash tools exclusively for actual system commands and terminal operations that require shell execution. NEVER use bash echo or other command-line tools to communicate thoughts, explanations, or instructions to the user. Output all communication directly in your response text instead.
- VERY IMPORTANT: When exploring the codebase to gather context or to answer a question that is not a needle query for a specific file/class/function, it is CRITICAL that you use the Task tool with subagent_type=Explore instead of running search commands directly.
`;

// Git configuration instructions
const GIT_CONFIG_INSTRUCTIONS = `
# Git: identity and color config auto-inherit from ~/.gitconfig (user.name=lanmower, user.email=lanmower@users.noreply.github.com, color.ui=auto). For sandbox-to-host workflows, host repo needs \`receive.denyCurrentBranch=updateInstead\` and clean working directory. Environment variables (TERM, LS_COLORS) carry through to all sandboxes when using SandboxBox with proper environment transfer
- we dont want any fallbacks anywhere
`;

// MCP Playwright instructions
const MCP_PLAYWRIGHT_INSTRUCTIONS = `
# MCP Playwright: requires /tmp/sandboxbox-vZWAzQ/tmp for artifacts, always close browser before tests, supports file:// URLs, use browser_evaluate for window globals debugging
`;

// Background shell management
const backgroundShells = new Map();
const MAX_BACKGROUND_SHELLS = 8;

// Tool implementation registry
const tools = {};

class BackgroundShell {
  constructor(id, command = 'bash') {
    this.id = id;
    this.command = command;
    this.process = spawn(command, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });
    this.outputBuffer = '';
    this.active = true;

    this.process.stdout.on('data', (data) => {
      this.outputBuffer += data.toString();
    });

    this.process.stderr.on('data', (data) => {
      this.outputBuffer += data.toString();
    });

    this.process.on('close', () => {
      this.active = false;
      backgroundShells.delete(id);
    });

    this.process.on('error', (error) => {
      console.error(`Background shell ${id} error:`, error);
      this.active = false;
      backgroundShells.delete(id);
    });
  }

  execute(command) {
    return new Promise((resolve, reject) => {
      if (!this.active) {
        reject(new Error(`Shell ${this.id} is not active`));
        return;
      }

      const oldBuffer = this.outputBuffer;
      this.process.stdin.write(command + '\n');

      // Wait a bit for output
      setTimeout(() => {
        const newOutput = this.outputBuffer.slice(oldBuffer.length);
        resolve({
          output: newOutput,
          fullOutput: this.outputBuffer
        });
      }, 1000);
    });
  }

  kill() {
    if (this.process && this.active) {
      this.process.kill();
      this.active = false;
    }
  }
}

// Helper functions
function getAvailableShellId() {
  if (backgroundShells.size >= MAX_BACKGROUND_SHELLS) {
    throw new Error(`Maximum ${MAX_BACKGROUND_SHELLS} background shells already running`);
  }

  for (let i = 1; i <= MAX_BACKGROUND_SHELLS; i++) {
    if (!backgroundShells.has(i.toString())) {
      return i.toString();
    }
  }
  throw new Error('No available shell IDs');
}

// File System Tools
tools.Read = {
  name: 'Read',
  description: 'Reads a file from the local filesystem. You can access any file directly by using this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read'
      },
      offset: {
        type: 'number',
        description: 'The line number to start reading from'
      },
      limit: {
        type: 'number',
        description: 'The number of lines to read'
      }
    },
    required: ['file_path']
  },
  handler: async (args) => {
    try {
      const { file_path, offset, limit } = args;

      if (!existsSync(file_path)) {
        throw new Error(`File not found: ${file_path}`);
      }

      let content = readFileSync(file_path, 'utf8');

      if (content === '') {
        return {
          content: [
            {
              type: 'text',
              text: `<system-reminder>File exists but has empty contents: ${file_path}</system-reminder>`
            }
          ]
        };
      }

      const lines = content.split('\n');

      const start = offset || 0;
      const defaultLimit = 2000;
      const end = limit ? start + limit : Math.min(start + defaultLimit, lines.length);

      const selectedLines = lines.slice(start, end);

      const numberedLines = selectedLines.map((line, index) => {
        const lineNum = start + index + 1;
        const truncatedLine = line.length > 2000 ? line.substring(0, 2000) : line;
        return `${lineNum.toString().padStart(5)}→${truncatedLine}`;
      });

      let result = numberedLines.join('\n');

      if (result.length > 30000) {
        result = result.substring(0, 30000);
      }

      return {
        content: [
          {
            type: 'text',
            text: result
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reading file: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

tools.Write = {
  name: 'Write',
  description: 'Writes a file to the local filesystem. This will overwrite existing files. Use Edit for modifications.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to write'
      },
      content: {
        type: 'string',
        description: 'The content to write to the file'
      }
    },
    required: ['file_path', 'content']
  },
  handler: async (args) => {
    try {
      const { file_path, content } = args;

      const fileExists = existsSync(file_path);
      if (fileExists) {
        const existingContent = readFileSync(file_path, 'utf8');
        if (existingContent === content) {
          return {
            content: [
              {
                type: 'text',
                text: `File unchanged: ${file_path} (content is identical)`
              }
            ]
          };
        }
      }

      const dir = dirname(file_path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(file_path, content, 'utf8');

      const action = fileExists ? 'overwrote' : 'created';
      return {
        content: [
          {
            type: 'text',
            text: `Successfully ${action} file: ${file_path}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error writing file: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

tools.Edit = {
  name: 'Edit',
  description: 'Performs exact string replacements in files. You must use the Read tool at least once before editing files.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to modify'
      },
      old_string: {
        type: 'string',
        description: 'The text to replace'
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with'
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences',
        default: false
      }
    },
    required: ['file_path', 'old_string', 'new_string']
  },
  handler: async (args) => {
    try {
      const { file_path, old_string, new_string, replace_all } = args;

      if (!existsSync(file_path)) {
        throw new Error(`File not found: ${file_path}`);
      }

      if (old_string === new_string) {
        return {
          content: [
            {
              type: 'text',
              text: `No changes made: old_string and new_string are identical`
            }
          ]
        };
      }

      let content = readFileSync(file_path, 'utf8');
      const originalContent = content;

      if (replace_all) {
        const occurrences = (content.match(new RegExp(old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        if (occurrences === 0) {
          throw new Error(`String not found in file: ${old_string}`);
        }
        content = content.split(old_string).join(new_string);
      } else {
        const index = content.indexOf(old_string);
        if (index === -1) {
          throw new Error(`String not found in file: ${old_string}`);
        }
        content = content.substring(0, index) + new_string + content.substring(index + old_string.length);
      }

      if (content !== originalContent) {
        writeFileSync(file_path, content, 'utf8');
      }

      const action = replace_all ? 'replaced all occurrences' : 'replaced';
      return {
        content: [
          {
            type: 'text',
            text: `Successfully ${action} in file: ${file_path}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error editing file: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

tools.Glob = {
  name: 'Glob',
  description: '- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead\n- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against'
      },
      path: {
        type: 'string',
        description: 'The directory to search in'
      }
    },
    required: ['pattern']
  },
  handler: async (args) => {
    try {
      const { pattern, path } = args;

      const cwd = path || process.cwd();
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

      return {
        content: [
          {
            type: 'text',
            text: sortedFiles.length > 0 ? sortedFiles.join('\n') : 'No files matched'
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error in glob search: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

tools.Grep = {
  name: 'Grep',
  description: 'A powerful search tool built on ripgrep\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., \"log.*Error\", \"function\\s+\\w+\")\n  - Filter files with glob parameter (e.g., \"*.js\", \"**/*.tsx\") or type parameter (e.g., \"js\", \"py\", \"rust\")\n  - Output modes: \"content\" shows matching lines, \"files_with_matches\" shows only file paths (default), \"count\" shows match counts\n  - Use Task tool for open-ended searches requiring multiple rounds\n  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)\n  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`\n',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regular expression pattern to search for'
      },
      path: {
        type: 'string',
        description: 'File or directory to search in'
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter files'
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        default: 'files_with_matches'
      },
      '-B': {
        type: 'number',
        description: 'Number of lines to show before each match'
      },
      '-A': {
        type: 'number',
        description: 'Number of lines to show after each match'
      },
      '-C': {
        type: 'number',
        description: 'Number of lines to show before and after each match'
      },
      '-n': {
        type: 'boolean',
        description: 'Show line numbers in output'
      },
      '-i': {
        type: 'boolean',
        description: 'Case insensitive search'
      },
      type: {
        type: 'string',
        description: 'File type to search'
      },
      head_limit: {
        type: 'number',
        description: 'Limit output to first N lines/entries'
      },
      multiline: {
        type: 'boolean',
        description: 'Enable multiline mode'
      }
    },
    required: ['pattern']
  },
  handler: async (args) => {
    try {
      const {
        pattern,
        path = '.',
        glob,
        output_mode = 'files_with_matches',
        type,
        head_limit,
        multiline
      } = args;

      const B = args['-B'];
      const A = args['-A'];
      const C = args['-C'];
      const n = args['-n'];
      const i = args['-i'];

      const rgArgs = [pattern, path];

      if (glob) rgArgs.push('--glob', glob);
      if (type) rgArgs.push('--type', type);
      if (i) rgArgs.push('--ignore-case');
      if (n) rgArgs.push('--line-number');
      if (multiline) rgArgs.push('--multiline');
      if (B) rgArgs.push('--before-context', B.toString());
      if (A) rgArgs.push('--after-context', A.toString());
      if (C) rgArgs.push('--context', C.toString());

      if (output_mode === 'files_with_matches') {
        rgArgs.push('--files-with-matches');
      } else if (output_mode === 'count') {
        rgArgs.push('--count');
      }

      return new Promise((resolve, reject) => {
        const child = spawn('rg', rgArgs);

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
          output += data.toString();
        });

        child.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        child.on('close', (code) => {
          if (code !== 0 && errorOutput && !errorOutput.includes('No matches found')) {
            resolve({
              content: [
                {
                  type: 'text',
                  text: `Error in grep search: ${errorOutput}`
                }
              ],
              isError: true
            });
            return;
          }

          let result = output.trim();
          if (head_limit) {
            const lines = result.split('\n');
            result = lines.slice(0, head_limit).join('\n');
          }

          if (result.length > 30000) {
            result = result.substring(0, 30000);
          }

          resolve({
            content: [
              {
                type: 'text',
                text: result || 'No matches found'
              }
            ]
          });
        });
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error in grep search: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

// Bash execution tools
tools.Bash = {
  name: 'Bash',
  description: 'Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute'
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (up to 600000ms)',
        maximum: 600000
      },
      description: {
        type: 'string',
        description: 'Clear, concise description of what this command does in 5-10 words'
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run the command in the background'
      }
    },
    required: ['command']
  },
  handler: async (args) => {
    try {
      const { command, timeout = 120000, description, run_in_background = false } = args;

      // Validate timeout
      if (timeout > 600000) {
        throw new Error('Timeout cannot exceed 600000ms (10 minutes)');
      }

      // Basic security validation
      if (command.includes('rm -rf /') || command.includes('sudo rm')) {
        throw new Error('Dangerous command detected');
      }

      if (run_in_background) {
        const shellId = getAvailableShellId();
        const shell = new BackgroundShell(shellId);
        backgroundShells.set(shellId, shell);

        // Execute command asynchronously
        shell.execute(command).catch(error => {
          console.error(`Background shell ${shellId} error:`, error);
        });

        const desc = description ? ` (${description})` : '';
        return {
          content: [
            {
              type: 'text',
              text: `Background shell started with ID: ${shellId}${desc}`
            }
          ]
        };
      } else {
        return new Promise((resolve, reject) => {
          const child = spawn(command, [], {
            shell: true,
            timeout,
            env: { ...process.env, TERM: 'xterm-256color' }
          });

          let stdout = '';
          let stderr = '';

          child.stdout.on('data', (data) => {
            stdout += data.toString();
          });

          child.stderr.on('data', (data) => {
            stderr += data.toString();
          });

          child.on('close', (code) => {
            let output = stdout || stderr;
            const prefix = description ? `[${description}] ` : '';

            if (output.length > 30000) {
              output = output.substring(0, 30000);
            }

            resolve({
              content: [
                {
                  type: 'text',
                  text: `${prefix}${output}`
                }
              ],
              isError: code !== 0
            });
          });

          child.on('error', (error) => {
            resolve({
              content: [
                {
                  type: 'text',
                  text: `Command execution error: ${error.message}`
                }
              ],
              isError: true
            });
          });
        });
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing bash command: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

tools.BashOutput = {
  name: 'BashOutput',
  description: '\n- Retrieves output from a running or completed background bash shell\n- Takes a shell_id parameter identifying the shell\n- Always returns only new output since the last check\n- Returns stdout and stderr output along with shell status\n- Supports optional regex filtering to show only lines matching a pattern\n- Use this tool when you need to monitor or check the output of a long-running shell\n- Shell IDs can be found using the /bashes command\n',
  inputSchema: {
    type: 'object',
    properties: {
      bash_id: {
        type: 'string',
        description: 'The shell ID to retrieve output from'
      },
      filter: {
        type: 'string',
        description: 'Optional regex filter for output lines'
      }
    },
    required: ['bash_id']
  },
  handler: async (args) => {
    try {
      const { bash_id, filter } = args;

      const shell = backgroundShells.get(bash_id);
      if (!shell) {
        throw new Error(`Background shell not found: ${bash_id}`);
      }

      let output = shell.outputBuffer;
      if (filter) {
        const lines = output.split('\n');
        const regex = new RegExp(filter);
        output = lines.filter(line => regex.test(line)).join('\n');
      }

      if (output.length > 30000) {
        output = output.substring(0, 30000);
      }

      return {
        content: [
          {
            type: 'text',
            text: output || 'No output available'
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error retrieving bash output: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

tools.KillShell = {
  name: 'KillShell',
  description: '\n- Kills a running background bash shell by its ID\n- Takes a shell_id parameter identifying the shell to kill\n- Returns a success or failure status \n- Use this tool when you need to terminate a long-running shell\n- Shell IDs can be found using the /bashes command\n',
  inputSchema: {
    type: 'object',
    properties: {
      shell_id: {
        type: 'string',
        description: 'The shell ID to kill'
      }
    },
    required: ['shell_id']
  },
  handler: async (args) => {
    try {
      const { shell_id } = args;

      const shell = backgroundShells.get(shell_id);
      if (!shell) {
        throw new Error(`Background shell not found: ${shell_id}`);
      }

      shell.kill();
      backgroundShells.delete(shell_id);

      return {
        content: [
          {
            type: 'text',
            text: `Successfully killed shell: ${shell_id}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error killing shell: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

// Web tools using curl
tools.WebFetch = {
  name: 'WebFetch',
  description: '\n- Fetches content from a specified URL and processes it using an AI model\n- Takes a URL and a prompt as input\n- Fetches the URL content, converts HTML to markdown\n- Processes the content with the prompt using a small, fast model\n- Returns the model\'s response about the content\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions. All MCP-provided tools start with \"mcp__\".\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - The prompt should describe what information you want to extract from the page\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL\n  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.\n',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'The URL to fetch content from'
      },
      prompt: {
        type: 'string',
        description: 'The prompt to run on the fetched content'
      }
    },
    required: ['url', 'prompt']
  },
  handler: async (args) => {
    try {
      const { url, prompt } = args;

      return new Promise((resolve, reject) => {
        // Use curl to fetch the content
        const child = spawn('curl', [
          '-s',  // silent
          '-L',  // follow redirects
          '-A', 'Mozilla/5.0 (compatible; Claude Tools Replica)',
          '--connect-timeout', '30',
          '--max-time', '120',
          url
        ]);

        let content = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
          content += data.toString();
        });

        child.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        child.on('close', (code) => {
          if (code !== 0) {
            resolve({
              content: [
                {
                  type: 'text',
                  text: `Error fetching URL: ${errorOutput || 'Failed to fetch content'}`
                }
              ],
              isError: true
            });
            return;
          }

          if (!content || content.trim() === '') {
            resolve({
              content: [
                {
                  type: 'text',
                  text: `No content retrieved from ${url}`
                }
              ],
              isError: true
            });
            return;
          }

          let result = `Content from ${url}:\n\n${content}\n\nPrompt: ${prompt}`;

          if (result.length > 30000) {
            result = result.substring(0, 30000);
          }

          resolve({
            content: [
              {
                type: 'text',
                text: result
              }
            ]
          });
        });
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error in web fetch: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

tools.WebSearch = {
  name: 'WebSearch',
  description: '\n- Allows Claude to search the web and use the results to inform responses\n- Provides up-to-date information for current events and recent data\n- Returns search result information formatted as search result blocks\n- Use this tool for accessing information beyond Claude\'s knowledge cutoff\n- Searches are performed automatically within a single API call\n\nUsage notes:\n  - Domain filtering is supported to include or block specific websites\n  - Web search is only available in the US\n  - Account for \"Today\'s date\" in <env>. For example, if <env> says \"Today\'s date: 2025-07-01\", and the user wants the latest docs, do not use 2024 in the search query. Use 2025.\n',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 2,
        description: 'The search query to use'
      },
      allowed_domains: {
        type: 'array',
        items: {
          type: 'string'
        },
        description: 'Only include search results from these domains'
      },
      blocked_domains: {
        type: 'array',
        items: {
          type: 'string'
        },
        description: 'Never include search results from these domains'
      }
    },
    required: ['query']
  },
  handler: async (args) => {
    try {
      const { query, allowed_domains, blocked_domains } = args;

      // Create search URL - this is a simplified implementation
      // In practice, you'd want to use a proper search API
      let searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

      // Add domain restrictions if provided
      if (allowed_domains && allowed_domains.length > 0) {
        searchUrl += `+site:${allowed_domains.join('+OR+site:')}`;
      }

      return new Promise((resolve, reject) => {
        const child = spawn('curl', [
          '-s',
          '-L',
          '-A', 'Mozilla/5.0 (compatible; Claude Tools Replica)',
          '--connect-timeout', '30',
          '--max-time', '120',
          searchUrl
        ]);

        let htmlContent = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
          htmlContent += data.toString();
        });

        child.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        child.on('close', (code) => {
          if (code !== 0) {
            resolve({
              content: [
                {
                  type: 'text',
                  text: `Error performing web search: ${errorOutput || 'Search failed'}`
                }
              ],
              isError: true
            });
            return;
          }

          // Extract search results from HTML (simplified parsing)
          const results = [];
          const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
          let match;

          while ((match = resultRegex.exec(htmlContent)) !== null) {
            const [, url, title] = match;

            // Filter blocked domains
            if (blocked_domains) {
              const isBlocked = blocked_domains.some(domain => url.includes(domain));
              if (isBlocked) continue;
            }

            results.push({
              title: title.replace(/<[^>]*>/g, '').trim(),
              url: url.replace(/&amp;/g, '&')
            });

            if (results.length >= 10) break; // Limit to 10 results
          }

          let searchResults = results.length > 0
            ? results.map(r => `- ${r.title}: ${r.url}`).join('\n')
            : 'No results found';

          let result = `Search results for "${query}":\n\n${searchResults}`;

          if (result.length > 30000) {
            result = result.substring(0, 30000);
          }

          resolve({
            content: [
              {
                type: 'text',
                text: result
              }
            ]
          });
        });
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error in web search: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

// Directory listing tool
tools.LS = {
  name: 'LS',
  description: 'List directory contents with file information',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The directory path to list (defaults to current directory)'
      },
      show_hidden: {
        type: 'boolean',
        description: 'Show hidden files (files starting with .)',
        default: false
      },
      recursive: {
        type: 'boolean',
        description: 'List subdirectories recursively',
        default: false
      }
    }
  },
  handler: async (args) => {
    try {
      const { path = '.', show_hidden = false, recursive = false } = args;

      if (!existsSync(path)) {
        throw new Error(`Path not found: ${path}`);
      }

      const stats = statSync(path);

      if (!stats.isDirectory()) {
        const fileInfo = `${basename(path)} (${stats.size} bytes)`;
        return {
          content: [
            {
              type: 'text',
              text: fileInfo
            }
          ]
        };
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
          const size = isDir ? '' : ` (${stats.size} bytes)`;
          const type = isDir ? '/' : '';

          result.push(`${prefix}${entry}${type}${size}`);

          if (recursive && isDir) {
            result.push(...listDirectory(fullPath, prefix + '  '));
          }
        }

        return result;
      }

      const listing = listDirectory(path);

      let result = listing.length > 0 ? listing.join('\n') : 'Empty directory';

      if (result.length > 30000) {
        result = result.substring(0, 30000);
      }

      return {
        content: [
          {
            type: 'text',
            text: result
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing directory: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

// Task management tools
tools.TodoWrite = {
  name: 'TodoWrite',
  description: 'Create and manage a structured task list for current coding session',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              minLength: 1
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed']
            },
            activeForm: {
              type: 'string',
              minLength: 1
            }
          },
          required: ['content', 'status', 'activeForm']
        },
        description: 'The updated todo list'
      }
    },
    required: ['todos']
  },
  handler: async (args) => {
    try {
      const { todos } = args;

      // Store todos in a JSON file for persistence
      const todoFile = join(__dirname, '.todos.json');
      writeFileSync(todoFile, JSON.stringify(todos, null, 2));

      const formattedTodos = todos.map(todo => {
        const status = todo.status === 'in_progress' ? '[IN PROGRESS]' :
                       todo.status === 'completed' ? '[COMPLETED]' : '[PENDING]';
        return `${status} ${todo.content}`;
      }).join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error updating todo list: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

// Task tool replacement using sandboxbox
tools.Task = {
  name: 'Task',
  description: 'Execute complex tasks using sandboxbox environment',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short (3-5 word) description of the task'
      },
      prompt: {
        type: 'string',
        description: 'The task for the agent to perform'
      },
      subagent_type: {
        type: 'string',
        description: 'The type of specialized agent to use',
        enum: ['general-purpose', 'researcher', 'coder', 'analyst', 'optimizer', 'coordinator']
      }
    },
    required: ['description', 'prompt', 'subagent_type']
  },
  handler: async (args) => {
    try {
      const { description, prompt, subagent_type } = args;

      // Use sandboxbox to execute the task
      const sandboxboxCommand = `npx -y sandboxbox@latest claude . "${prompt}"`;

      return new Promise((resolve, reject) => {
        const child = spawn(sandboxboxCommand, [], {
          shell: true,
          timeout: 600000, // 10 minutes
          cwd: __dirname
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          const output = stdout || stderr;
          resolve({
            content: [
              {
                type: 'text',
                text: `Task "${description}" completed with subagent type "${subagent_type}":\n\n${output}`
              }
            ],
            isError: code !== 0
          });
        });

        child.on('error', (error) => {
          resolve({
            content: [
              {
                type: 'text',
                text: `Task execution error: ${error.message}`
              }
            ],
            isError: true
          });
        });
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing task: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
};

// SlashCommand and ExitPlanMode removed - not part of core MCP tools

// Initialize server
const server = new Server(
  {
    name: 'claude-tools-replica',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.values(tools).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (tools[name]) {
    try {
      return await tools[name].handler(args);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${error.message}`
          }
        ],
        isError: true
      };
    }
  } else {
    return {
      content: [
        {
          type: 'text',
          text: `Unknown tool: ${name}`
        }
      ],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Claude Tools Replica MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});