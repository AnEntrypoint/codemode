#!/usr/bin/env node

import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import chalk from 'chalk';
import hljs from 'highlight.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function formatCode(code, language = 'javascript') {
  try {
    const highlighted = hljs.highlight(code, { language, ignoreIllegals: true });
    return highlighted.value
      .split('\n')
      .map(line => {
        return line
          .replace(/<span class="hljs-keyword">(.*?)<\/span>/g, chalk.magenta('$1'))
          .replace(/<span class="hljs-string">(.*?)<\/span>/g, chalk.green('$1'))
          .replace(/<span class="hljs-number">(.*?)<\/span>/g, chalk.yellow('$1'))
          .replace(/<span class="hljs-comment">(.*?)<\/span>/g, chalk.gray('$1'))
          .replace(/<span class="hljs-function">(.*?)<\/span>/g, chalk.blue('$1'))
          .replace(/<span class="hljs-title function_">(.*?)<\/span>/g, chalk.cyan('$1'))
          .replace(/<span class="hljs-variable">(.*?)<\/span>/g, chalk.white('$1'))
          .replace(/<span class="hljs-built_in">(.*?)<\/span>/g, chalk.cyan('$1'))
          .replace(/<span class="hljs-attr">(.*?)<\/span>/g, chalk.cyan('$1'))
          .replace(/<span class="hljs-name">(.*?)<\/span>/g, chalk.blue('$1'))
          .replace(/<span class="hljs-tag">(.*?)<\/span>/g, chalk.blue('$1'))
          .replace(/<span class="hljs-operator">(.*?)<\/span>/g, chalk.white('$1'))
          .replace(/<span class="hljs-punctuation">(.*?)<\/span>/g, chalk.white('$1'))
          .replace(/<span class="[^"]*">(.*?)<\/span>/g, '$1');
      })
      .join('\n');
  } catch (error) {
    return code;
  }
}

function printSection(title, content, color = 'cyan') {
  console.log('');
  console.log(chalk[color].bold(`▸ ${title}`));
  console.log(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 80, 80))));
  console.log(content);
  console.log('');
}

function printCodeBlock(code, language = 'javascript') {
  const formatted = formatCode(code, language);
  console.log('');
  console.log(chalk.gray('┌─ Code Execution'));
  formatted.split('\n').forEach((line, i) => {
    const lineNum = String(i + 1).padStart(3, ' ');
    console.log(chalk.gray('│ ') + chalk.gray(lineNum) + chalk.gray(' │ ') + line);
  });
  console.log(chalk.gray('└─'));
  console.log('');
}

const args = process.argv.slice(2);
const isAgentMode = args.includes('--agent');

if (!isAgentMode) {
  console.error('Usage: node agent.js --agent [task]');
  console.error('       codemode --agent [task]');
  process.exit(1);
}

const taskIndex = args.indexOf('--agent') + 1;
const task = taskIndex < args.length ? args.slice(taskIndex).join(' ') : 'Clean up this codebase';

console.log('');
console.log(chalk.blue.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(chalk.blue.bold('  CodeMode Agent Session Start'));
console.log(chalk.blue.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log('');
console.log(chalk.cyan.bold('📋 Task:'), chalk.white(task));
console.log(chalk.cyan.bold('📁 Working Directory:'), chalk.white(process.cwd()));
console.log(chalk.cyan.bold('🤖 Model:'), chalk.white('claude-sonnet-4-5'));
console.log(chalk.cyan.bold('💭 Thinking:'), chalk.white('Enabled (10,000 token budget)'));
console.log('');
console.log(chalk.yellow.bold('━━━ Initializing Session ━━━'));
console.log('');
console.log(chalk.cyan.bold('1️⃣  Loading CLI Tools'));
console.log(chalk.gray('   ├─ Fetching glootie-cc documentation...'));

let additionalTools = '';
let startMd = '';
let mcpThorns = '';
let wfgyHook = '';

try {
  startMd = execSync('curl -s https://raw.githubusercontent.com/AnEntrypoint/glootie-cc/refs/heads/master/start.md', { encoding: 'utf8', timeout: 5000 });
  console.log(chalk.green('   ✓ glootie-cc documentation loaded'));
} catch (error) {
  console.log(chalk.yellow('   ⚠ Warning: Failed to fetch glootie-cc:'), chalk.gray(error.message));
}

console.log(chalk.gray('   ├─ Loading mcp-thorns...'));
try {
  mcpThorns = execSync('npx -y mcp-thorns@latest', { encoding: 'utf8', timeout: 10000 });
  console.log(chalk.green('   ✓ mcp-thorns loaded'));
} catch (error) {
  console.log(chalk.yellow('   ⚠ Warning: Failed to load mcp-thorns:'), chalk.gray(error.message));
}

console.log(chalk.gray('   ├─ Loading wfgy hooks...'));
try {
  wfgyHook = execSync('npx -y wfgy@latest hook', { encoding: 'utf8', timeout: 10000 });
  console.log(chalk.green('   ✓ wfgy hooks loaded'));
} catch (error) {
  console.log(chalk.yellow('   ⚠ Warning: Failed to load wfgy:'), chalk.gray(error.message));
}

additionalTools = `\n\n# Additional Tool Documentation\n\n${startMd}\n\n${wfgyHook}\n\n`;

console.log(chalk.cyan.bold('2️⃣  Loading MCP Servers'));

let mcpConfig = { mcpServers: {} };
const configPaths = [
  join(process.cwd(), '.codemode.json'),
  join(__dirname, '.codemode.json'),
  join(process.env.HOME || process.env.USERPROFILE || '~', '.claude', '.codemode.json')
];

for (const configPath of configPaths) {
  try {
    if (existsSync(configPath)) {
      mcpConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log(chalk.gray(`   ├─ Config loaded from: ${configPath}`));
      break;
    }
  } catch (error) {
    console.log(chalk.yellow(`   ⚠ Failed to load ${configPath}`));
  }
}

const mcpServerNames = Object.keys(mcpConfig.mcpServers || {}).filter(name => name !== 'codeMode');
if (mcpServerNames.length > 0) {
  mcpServerNames.forEach((serverName, index) => {
    const server = mcpConfig.mcpServers[serverName];
    const isLast = index === mcpServerNames.length - 1;
    const prefix = isLast ? '   └─' : '   ├─';
    console.log(chalk.gray(`${prefix} ${serverName}: ${server.command} ${server.args.join(' ')}`));
  });
  console.log(chalk.green(`   ✓ ${mcpServerNames.length} MCP server(s) configured`));
} else {
  console.log(chalk.yellow('   ⚠ No MCP servers configured'));
}
console.log('');

console.log(chalk.cyan.bold('3️⃣  Initializing Agent'));
console.log(chalk.gray('   ├─ Setting up execute tool with MCP integration...'));
console.log(chalk.gray('   ├─ Enabling extended thinking mode...'));
console.log(chalk.gray('   └─ Starting Claude agent...'));
console.log('');

const agentPrompt = `You are an AI assistant with access to an execute tool that allows you to run JavaScript code in real time, you must use this environment to fulfill the task as changes to the current folder.

# Execute Tool persistent-context repl interface with extra tools, execute provides these functions that you can call in your JavaScript code:

IMPORTANT: Use the global function names directly (Read, Write, LS, etc.) NOT builtInTools.Read or builtInTools.Write
Relative paths are automatically resolved to the working directory.

## File Operations
await Read(path, offset?, limit?) Read file content with optional offset and limit
await Write(path, content) Write content to file
await Edit(path, oldString, newString, replaceAll?) Edit file by replacing strings
await Glob(pattern, path?) Find files matching glob pattern

## Search Operations
await Grep(pattern, path?, options?) Search for pattern in files using ripgrep
  Options: {glob, type, output_mode, '-i', '-n', '-A', '-B', '-C', multiline, head_limit}

## System Operations
await Bash(command, description?, timeout?) Execute shell command
await LS(path?, show_hidden?, recursive?) List directory contents

## Web Operations
await WebFetch(url, prompt) Fetch and analyze web content
await WebSearch(query, allowed_domains?, blocked_domains?) Search the web

## Task Management
await TodoWrite(todos) Write todo list
  Format: [{content, status, activeForm}] where status is 'pending'|'in_progress'|'completed'

## MCP Tools (from configured servers)
All MCP tools from glootie, playwright, and vexify are also available via their namespaces.
Use browser automation (playwright.*), code analysis (glootie.*), and semantic search (vexify.*) as needed.

# Instructions

Avoid using const in execute use mutables that can be overridden later
Use the execute tool to run JavaScript code with these functions available
use programmatic flow to reduce the amount of execute calls needed, conditionals, loops, and code structure is available to you no need for linear tool-by-tool execution
Write code that completes the entire task, use as many executions as you need to
All MCP tools are async functions. Always use "await" when calling them.
Before asking the user to do something, first check if you can do it yourself or with any of your tools
Always apply all code changes to the codebase before finishing
Your real time environment can import parts of the codebase, use that to isolate each part and test if it works during debugging
Mandatory: always continuously update and maintain the todo list as a plan to complete the entire requested task, keep working and updating it till the entire task is complete

# CRITICAL: Console Logging Guidelines

Console output feeds back to you as execution results. Only log data you need to acquire for decision-making.

NEVER log:
- Thinking process or reasoning
- Step descriptions or progress narratives
- Action descriptions or status messages
- Completion confirmations or success indicators

ONLY log:
- Raw data needed for analysis
- Query results required for next steps
- Information that answers specific questions

Keep output minimal and data-focused. Use code logic to filter and extract only essential information.

# Task
${task}

# Context
Working directory: ${process.cwd()}
Date: ${new Date().toISOString().split('T')[0]}${additionalTools}

# Codebase
${mcpThorns}
`;

async function runAgent() {
  try {
    console.log(chalk.green.bold('✓ Session initialized successfully'));
    console.log('');
    console.log(chalk.blue.bold('━━━ Agent Execution Started ━━━'));
    console.log('');

    const agentQuery = query({
      prompt: agentPrompt,
      options: {
        model: 'sonnet',
        permissionMode: 'bypassPermissions',
        allowedTools: ['mcp__codeMode__execute'],
        disallowedTools: [
          'Task', 'Bash', 'Glob', 'Grep', 'ExitPlanMode', 'Read', 'Edit', 'Write',
          'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'BashOutput', 'KillShell',
          'SlashCommand', 'Skill'
        ],
        thinking: {
          type: 'enabled',
          budget_tokens: 10000
        },
        mcpServers: {
          codeMode: {
            type: 'stdio',
            command: 'node',
            args: [dirname(__filename) + '/code-mode.js'],
            cwd: __dirname
          }
        }
      }
    });

    let currentThinkingBlock = '';
    let isThinking = false;
    let thinkingBlockCount = 0;

    for await (const message of agentQuery) {
      if (message.type === 'text') {
        console.log(message.text);
      } else if (message.type === 'thinking_delta' || message.type === 'thinking') {
        if (!isThinking) {
          thinkingBlockCount++;
          isThinking = true;
          console.log('');
          console.log(chalk.yellow.bold(`💭 Thinking (Block ${thinkingBlockCount})`));
          console.log(chalk.gray('┌─────────────────────────────────────────────'));
        }

        const thinkingText = message.thinking || message.delta?.thinking || '';
        currentThinkingBlock += thinkingText;

        process.stdout.write(chalk.gray('│ ') + chalk.yellow(thinkingText));

      } else if (message.type === 'assistant') {
        if (isThinking) {
          console.log('');
          console.log(chalk.gray('└─────────────────────────────────────────────'));
          console.log('');
          isThinking = false;
          currentThinkingBlock = '';
        }

        if (message.message && message.message.content) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            content.forEach(item => {
              if (item.type === 'text') {
                printSection('Response', item.text, 'green');
              } else if (item.type === 'thinking') {
                printSection('Thinking Summary', chalk.yellow(item.thinking), 'yellow');
              } else if (item.type === 'code') {
                printCodeBlock(item.code, 'javascript');
              } else if (item.type === 'tool_use') {
                console.log('');
                console.log(chalk.blue.bold('🔧 Tool Use:'), chalk.cyan(item.name));
                if (item.input) {
                  console.log(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 80, 80))));

                  // Format inputs nicely instead of JSON
                  for (const [key, value] of Object.entries(item.input)) {
                    const displayKey = chalk.cyan(`${key}:`);
                    if (typeof value === 'string') {
                      if (value.length > 200) {
                        console.log(displayKey, chalk.white(value));
                        console.log(chalk.gray(`          (${value.length} characters total)`));
                      } else if (value.includes('\n')) {
                        console.log(displayKey);
                        const lines = value.split('\n');
                        lines.forEach(line => {
                          console.log(chalk.gray('          ') + chalk.white(line));
                        });
                      } else {
                        console.log(displayKey, chalk.white(value));
                      }
                    } else if (typeof value === 'object' && value !== null) {
                      console.log(displayKey, chalk.white(JSON.stringify(value)));
                    } else {
                      console.log(displayKey, chalk.white(String(value)));
                    }
                  }
                }
                console.log('');
              } else if (item.type === 'tool_result') {
                console.log('');
                console.log(chalk.green.bold('✓ Tool Result'));
                console.log(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 80, 80))));

                // Extract text content from tool result
                let resultText = '';
                if (item.content) {
                  if (Array.isArray(item.content)) {
                    resultText = item.content
                      .filter(c => c.type === 'text')
                      .map(c => c.text)
                      .join('\n');
                  } else if (typeof item.content === 'string') {
                    resultText = item.content;
                  } else if (item.content.text) {
                    resultText = item.content.text;
                  }
                }

                // Display full output with no truncation
                if (resultText) {
                  console.log(chalk.white(resultText));
                }
                console.log('');
              }
            });
          }
        }
      } else if (message.type === 'user') {
        // Handle tool results that come as user messages
        if (message.message && message.message.content) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            content.forEach(item => {
              if (item.type === 'tool_result') {
                console.log('');
                console.log(chalk.green.bold('✓ Tool Result'));
                console.log(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 80, 80))));

                // Extract text content from tool result
                let resultText = '';
                if (item.content) {
                  if (Array.isArray(item.content)) {
                    resultText = item.content
                      .filter(c => c.type === 'text')
                      .map(c => c.text)
                      .join('\n');
                  } else if (typeof item.content === 'string') {
                    resultText = item.content;
                  } else if (item.content.text) {
                    resultText = item.content.text;
                  }
                }

                // Display full output with no truncation
                if (resultText) {
                  console.log(chalk.white(resultText));
                }
                console.log('');
              }
            });
          }
        }
      } else if (message.type === 'tool_result') {
        console.log('');
        console.log(chalk.green.bold('✓ Tool Result'));
        console.log(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 80, 80))));
        if (message.content) {
          const preview = String(message.content);
          console.log(chalk.white(preview));
          if (String(message.content).length > 500) {
            console.log(chalk.gray(`... (${String(message.content).length} total characters)`));
          }
        }
        console.log('');
      } else if (message.type === 'error') {
        console.log('');
        console.log(chalk.red.bold('✗ Error'));
        console.log(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 80, 80))));
        console.log(chalk.red(message.error || message.message));
        console.log('');
      } else {
        console.log(chalk.gray(`[Event: ${message.type}]`));
      }
    }

    if (isThinking) {
      console.log('');
      console.log(chalk.gray('└─────────────────────────────────────────────'));
      console.log('');
    }

    console.log('');
    console.log(chalk.green.bold('✓ Task completed successfully'));
    console.log('');

  } catch (error) {
    console.log('');
    console.log(chalk.red.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.red.bold('  ✗ Agent Error'));
    console.log(chalk.red.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
    console.log(chalk.red(error.message));
    if (error.stack) {
      console.log('');
      console.log(chalk.gray('Stack trace:'));
      console.log(chalk.gray(error.stack));
    }
    console.log('');
    process.exit(1);
  }
}

runAgent();
