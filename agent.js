#!/usr/bin/env node

import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import chalk from 'chalk';
import hljs from 'highlight.js';
import EnhancedInteractiveMode from './enhanced-interactive-mode.js';

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
const isNonInteractive = args.includes('--no-interactive');

if (!isAgentMode) {
  console.error('Usage: node agent.js --agent [task] [--no-interactive]');
  console.error('       codemode --agent [task] [--no-interactive]');
  process.exit(1);
}

const filteredArgs = args.filter(arg => arg !== '--agent' && arg !== '--no-interactive');
const task = filteredArgs.length > 0 ? filteredArgs.join(' ') : 'Clean up this codebase';

// Preserve the original working directory before it gets reset during execution
const originalCwd = process.cwd();

// Initialize persistent execution monitoring system
let interruptionSystem = null;
async function initializeInterruptionSystem() {
  try {
    // Try multiple import strategies for AgentInterruptionSystem
    let interruptionModule = null;

    // Strategy 1: Standard relative import
    try {
      interruptionModule = await import('./agent-interruption-system.js');
    } catch (error1) {
      // Strategy 2: Try with absolute path resolution
      try {
        const { fileURLToPath } = await import('url');
        const { dirname, join } = await import('path');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        interruptionModule = await import(join(__dirname, 'agent-interruption-system.js'));
      } catch (error2) {
        // Strategy 3: Create a basic stub system
        console.log(chalk.yellow('   ⚠ Using basic monitoring system - full functionality not available'));
        interruptionModule = {
          default: class BasicInterruptionSystem {
            async initialize() {
              console.log('[Basic Monitor] Basic monitoring initialized');
            }
            hasPendingNotifications() { return false; }
            getPendingNotifications() { return []; }
            markNotificationProcessed() {}
            generateAgentInstructions() { return ''; }
            stop() {}
            executeAction() { return { success: false, message: 'Not available in basic mode' }; }
          }
        };
      }
    }

    if (interruptionModule && interruptionModule.default) {
      interruptionSystem = new interruptionModule.default();
      await interruptionSystem.initialize((interruption) => {
      if (interruption) {
        console.log('');
        console.log(chalk.yellow.bold('🔔 PERSISTENT TASK NOTIFICATION:'));
        console.log(chalk.cyan('   Title:'), interruption.title);
        console.log(chalk.cyan('   Message:'), interruption.message);
        console.log(chalk.cyan('   Execution ID:'), interruption.executionId);
        console.log(chalk.cyan('   Duration:'), interruption.execution.duration + 's');
        console.log('');
        console.log(chalk.yellow('   Available actions:'));
        interruption.actions.forEach(action => {
          console.log(chalk.gray(`     - ${action.name}: ${action.description}`));
        });
        console.log('');
      }
      });
      console.log(chalk.green('   ✓ Persistent execution monitoring initialized'));
    }
  } catch (error) {
    console.log(chalk.yellow('   ⚠ Warning: Failed to initialize interruption system:', error.message));
  }
}

let interactiveMode = null;
// In agent mode, we don't use interactive mode at all
if (!isNonInteractive && !isAgentMode) {
  interactiveMode = new EnhancedInteractiveMode();
  interactiveMode.init();
}

console.log('');
console.log(chalk.blue.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(chalk.blue.bold('  codemode Agent Session Start'));
console.log(chalk.blue.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log('');
console.log(chalk.cyan.bold('📋 Task:'), chalk.white(task));
console.log(chalk.cyan.bold('📁 Working Directory:'), chalk.white(process.cwd()));
console.log(chalk.cyan.bold('🤖 Model:'), chalk.white('claude-sonnet-4-5'));
console.log(chalk.cyan.bold('💭 Thinking:'), chalk.white('Enabled (10,000 token budget)'));
console.log(chalk.cyan.bold('🔄 Mode:'), chalk.white(isNonInteractive ? 'Single execution' : 'Interactive (streaming)'));
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

const configPath = join(process.cwd(), '.codemode.json');
const defaultConfigPath = join(dirname(new URL(import.meta.url).pathname), '.codemode.json');
let mcpConfig = { mcpServers: {} };

try {
  if (existsSync(configPath)) {
    mcpConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    console.log(chalk.gray(`   ├─ Config loaded from: ${configPath}`));
  } else {
    // Use default config from codebase
    mcpConfig = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
    console.log(chalk.yellow(`   ├─ Project config not found, using default config`));
    console.log(chalk.gray(`   │  (Create ${configPath} to override)`));
  }
} catch (error) {
  console.error(chalk.red.bold(`Config loading error:`, error.message));
  console.error(chalk.yellow(`⚠️  Using default config from codebase`));
  // Always use the full default config from codebase as fallback
  mcpConfig = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
}

if (!mcpConfig.mcpServers) {
    throw new Error('BRUTAL ERROR: mcpConfig.mcpServers is undefined - NO FALLBACKS');
  }

// Resolve relative script paths to absolute paths relative to package installation
// AND set environment variables for working directory
// This ensures MCP servers can find their scripts AND operate on the correct working directory
const packageDir = dirname(new URL(import.meta.url).pathname);
const userWorkingDirectory = process.cwd();
for (const [serverName, serverConfig] of Object.entries(mcpConfig.mcpServers)) {
  if (serverConfig.args && Array.isArray(serverConfig.args)) {
    serverConfig.args = serverConfig.args.map(arg => {
      // If arg looks like a relative path to a .js file
      if (arg.endsWith('.js') && !arg.startsWith('/') && !arg.startsWith('\\') && !arg.match(/^[a-zA-Z]:/)) {
        return join(packageDir, arg);
      }
      return arg;
    });
  }

  // Set environment variable for working directory so MCP server knows where to operate
  if (!serverConfig.env) {
    serverConfig.env = {};
  }
  serverConfig.env.CODEMODE_WORKING_DIRECTORY = userWorkingDirectory;
}

const mcpServerNames = Object.keys(mcpConfig.mcpServers).filter(name => name !== 'codeMode');
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
console.log(chalk.gray('   ├─ Initializing persistent execution monitoring...'));
console.log(chalk.gray('   └─ Starting Claude agent...'));
console.log('');

// Initialize the interruption system
await initializeInterruptionSystem();

const interruptionInstructions = interruptionSystem ? interruptionSystem.generateAgentInstructions() : '';

const agentPrompt = `You are an AI assistant with access to a single mcp__codeMode__execute tool that allows you to run JavaScript code in real time. You must use this environment to fulfill the task as changes to the current folder.

# Execute Tool Interface

IMPORTANT: You only have access to the mcp__codeMode__execute tool. Use it to run JavaScript code that provides these functions:

## File Operations
await Read(path, offset?, limit?) → string - Read file content with line numbers (returns string, not object)
await Write(path, content) → null - Write content to file (returns null on success)
await Edit(path, oldString, newString, replaceAll?) → null - Edit file by replacing strings (returns null on success)
await Glob(pattern, path?) → string[] - Find files matching glob pattern (returns array of file paths)

## Search Operations
await Grep(pattern, path?, options?) → string - Search for pattern in files using ripgrep (returns formatted string)
  Options: {glob, type, output_mode: 'content'|'files_with_matches'|'count', '-i', '-n', '-A', '-B', '-C', multiline, head_limit}

## System Operations
await Bash(command, description?, timeout?) → string - Execute shell command (returns stdout+stderr as string)
await LS(path?, show_hidden?, recursive?) → string[] - List directory contents (returns array of strings)

## Web Operations
await WebFetch(url, prompt) → string - Fetch and analyze web content (returns analysis as string)
await WebSearch(query, allowed_domains?, blocked_domains?) → object - Search the web (returns search result object)

## Task Management
await TodoWrite(todos) → null - Write todo list (returns null on success)
  Format: [{content, status, activeForm}] where status is 'pending'|'in_progress'|'completed'

## Server Management
await get_server_state() → object - Check server status, running executions, context size
await kill_execution(execId?) → object - Kill specific execution or all if no id
await clear_context() → null - Reset everything, kills all executions and clears state
await get_async_execution(execId) → object - Get full execution log from async mode
await list_async_executions() → object[] - List all async executions with details

CRITICAL: Use mcp__codeMode__execute with a "code" parameter containing your JavaScript code.

# Server Management & Persistence

## Server State
The execution server PERSISTS across all execute calls. This means:
- Variables and state are preserved between executions
- Long-running processes continue until explicitly killed
- The server does NOT restart automatically

## Management Functions
await get_server_state() → Check server status, running executions, context size
await kill_execution(execId?) → Kill specific execution (id) or all if no id
await clear_context() → Reset everything, kills all executions and clears state
await get_async_execution(execId) → Get full execution log from async mode
await list_async_executions() → List all async executions with details

## Async Handover System
**IMPORTANT**: After 30 seconds, executions automatically move to async mode
- Blocking executions (30s) → Async mode (unlimited)
- Async executions store complete output history
- Retrieve async logs with get_async_execution()
- Check async status with list_async_executions()
- NO EXECUTIONS EVER TIMEOUT - agent controls lifecycle

## Process Safety Rules
- Use get_server_state() before starting processes to understand current state
- Long-running operations (>30s) will auto-handover to async mode
- Retrieve async execution logs to see complete history
- Kill any execution with kill_execution() - blocking or async
- clear_context() frees ALL resources - use when starting fresh work
- Never kill processes you don't understand - check state first

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

${interruptionInstructions}

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

    async function executeTask(taskPrompt) {
      if (interactiveMode) {
        interactiveMode.agentStarted();
        interactiveMode.pause();
      }

      console.log('🔍 Starting task execution...');
      console.log(`📝 Task prompt: ${taskPrompt.substring(0, 100)}...`);

      // Use the task prompt from the agent
      console.log('🎯 Using task prompt with working directory fix...');
      const testPrompt = taskPrompt;

      try {
        console.log('🔧 Creating agent query with proper MCP server configuration...');
        console.log(`📁 MCP server will run from: ${originalCwd}`);
        console.log('🔧 Only execute tool is allowed - all other tools disabled');

        // CRITICAL FIX: Restore working directory before creating query
        process.chdir(originalCwd);
        console.log(`🔄 Restored working directory to: ${process.cwd()}`);

        console.log('🚀 About to create Claude SDK query...');

      let agentQuery;
      try {
        agentQuery = query({
          prompt: testPrompt, // Use original task for testing
          options: {
            model: 'claude-sonnet-4-5',
            permissionMode: 'bypassPermissions',
            // FIXED: Only allow the execute tool
            allowedTools: ['mcp__codeMode__execute'],
            disallowedTools: [
              'Task', 'Bash', 'Glob', 'Grep', 'ExitPlanMode', 'Read', 'Edit', 'Write',
              'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'BashOutput', 'KillShell',
              'SlashCommand', 'Skill'
            ],
            thinking: {
              type: 'enabled',
              budget_tokens: 2000
            },
            mcpServers: mcpConfig.mcpServers
          }
        });

        console.log('✅ Claude SDK query created successfully!');
      } catch (queryError) {
        console.error('❌ Claude SDK query creation failed:', queryError.message);
        console.error('Stack trace:', queryError.stack);
        throw queryError;
      }

      console.log('🚀 Agent query created, starting to iterate messages...');
      console.log('⏳ Waiting for first message from agent...');

      let currentThinkingBlock = '';
      let isThinking = false;
      let thinkingBlockCount = 0;
      let messageCount = 0;
      let hasReceivedMessage = false;

      // Add timeout to detect if we're hanging (adjusted to 180 seconds to prevent false alarms)
      const messageTimeout = setTimeout(() => {
        if (!hasReceivedMessage) {
          console.log('⚠️  No messages received within 180 seconds - this indicates a communication issue');
          console.log('🔧 Possible causes:');
          console.log('   - MCP server not starting properly');
          console.log('   - Tool not being registered correctly');
          console.log('   - Query configuration issue');
          console.log('🚨 CRITICAL: The for-await loop is not iterating at all! (Note: This may be a false alarm if agent is still thinking)');
        }
      }, 180000);

      try {
        for await (const message of agentQuery) {
        if (!hasReceivedMessage) {
          clearTimeout(messageTimeout);
          hasReceivedMessage = true;
        }

        // Check for user interrupts
        if (interactiveMode && interactiveMode.checkForInterrupt()) {
          console.log('');
          console.log(chalk.yellow.bold('⚡ User interrupt detected!'));
          console.log(chalk.cyan('📝 Processing user command...'));

          // Get the interrupt command
          const interruptCommand = interactiveMode.getNextCommand();
          if (interruptCommand) {
            // Create a follow-up task from the interrupt
            const followUpPrompt = `${agentPrompt}\n\n# User Interrupt Command\n${interruptCommand}\n\nPlease acknowledge this interrupt and incorporate the user's request into your current work.`;

            // Break the current loop and start a new execution with the interrupt
            await executeTask(followUpPrompt);
            return; // Exit current execution
          }
        }

        // Skip notification checking for now to debug message flow
        // TODO: Re-enable once message flow is working correctly

        messageCount++;
        console.log(`📨 Received message ${messageCount}: ${message.type}`);
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

                  if (resultText) {
                    console.log(chalk.white(resultText));
                  }
                  console.log('');
                }
              });
            }
          }
        } else if (message.type === 'user') {
          if (message.message && message.message.content) {
            const content = message.message.content;
            if (Array.isArray(content)) {
              content.forEach(item => {
                if (item.type === 'tool_result') {
                  console.log('');
                  console.log(chalk.green.bold('✓ Tool Result'));
                  console.log(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 80, 80))));

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

      } catch (loopError) {
        console.error('❌ ERROR in for-await loop:', loopError.message);
        console.error('Stack trace:', loopError.stack);
        console.log('🚨 This is why the agent is exiting prematurely!');
      } finally {
        clearTimeout(messageTimeout);
      }

      if (isThinking) {
        console.log('');
        console.log(chalk.gray('└─────────────────────────────────────────────'));
        console.log('');
      }

      console.log(`✅ Task execution completed. Total messages received: ${messageCount}`);

      if (interactiveMode) {
        interactiveMode.agentFinished();
        interactiveMode.resume();
      }
      } catch (error) {
        console.error('❌ Task execution failed:', error);
        console.error('Stack trace:', error.stack);
        if (interactiveMode) {
          interactiveMode.resume();
        }
      }
    }

    // FIXED: Use proper agent prompt now that working directory is fixed
    await executeTask(agentPrompt);

    if (!isNonInteractive && !isAgentMode && interactiveMode) {
      // Set up event listener for user commands
      interactiveMode.on('userCommand', async (command) => {
        console.log('');
        console.log(chalk.blue.bold('━━━ New User Command ━━━'));
        console.log(chalk.cyan.bold('📋 Task:'), chalk.white(command));
        console.log('');

        const followUpPrompt = `${agentPrompt}\n\n# Follow-up Task\n${command}`;
        await executeTask(followUpPrompt);
      });

      // Keep the process alive for interactive commands
      console.log(chalk.green.bold('✅ Session ready for interactive commands...'));

      // Wait for either user commands or process termination
      return new Promise((resolve) => {
        process.on('SIGINT', () => {
          console.log('');
          console.log(chalk.yellow.bold('⚠ Received SIGINT (Ctrl-C), shutting down...'));
          if (interactiveMode) {
            interactiveMode.cleanup();
          }
          resolve();
        });

        process.on('SIGTERM', () => {
          console.log('');
          console.log(chalk.yellow.bold('⚠ Received SIGTERM, shutting down...'));
          if (interactiveMode) {
            interactiveMode.cleanup();
          }
          resolve();
        });
      });
    } else {
      console.log('');
      console.log(chalk.green.bold('✓ Task completed successfully'));
      console.log('');
    }

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

    if (interactiveMode) {
      interactiveMode.cleanup();
    }
    process.exit(1);
  }
}

// Handle Ctrl-C and termination signals
process.on('SIGINT', () => {
  console.log('');
  console.log(chalk.yellow.bold('⚠ Received SIGINT (Ctrl-C), shutting down...'));
  if (interactiveMode) {
    interactiveMode.cleanup();
  }
  if (interruptionSystem) {
    interruptionSystem.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('');
  console.log(chalk.yellow.bold('⚠ Received SIGTERM, shutting down...'));
  if (interactiveMode) {
    interactiveMode.cleanup();
  }
  if (interruptionSystem) {
    interruptionSystem.stop();
  }
  process.exit(0);
});

// Run the agent with async initialization
(async () => {
  try {
    await runAgent();
  } catch (error) {
    console.error(chalk.red.bold('Fatal error in agent:'), error);
    process.exit(1);
  }
})();
