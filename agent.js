#!/usr/bin/env node

// Agent using Claude Agent SDK with MCP tool integration
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const isAgentMode = args.includes('--agent');

if (!isAgentMode) {
  console.error('Usage: node agent.js --agent [task]');
  console.error('Example: node agent.js --agent "List all JavaScript files in this directory"');
  process.exit(1);
}

// Extract task from arguments
const taskIndex = args.indexOf('--agent') + 1;
const task = taskIndex < args.length ? args.slice(taskIndex).join(' ') : 'Help me with this codebase';

console.error('[Agent] Claude Agent with MCP Tool Access');
console.error(`[Agent] Task: ${task}`);
console.error('[Agent] Working directory:', process.cwd());

// Execute code using our MCP server
async function executeCode(code, workingDirectory = process.cwd()) {
  return new Promise((resolve, reject) => {
    console.error(`[Execute Tool] Running code in: ${workingDirectory}`);

    const proc = spawn('node', ['mcp-server.js'], {
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

    // Send tool call request
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'call',
        arguments: {
          workingDirectory,
          code,
          timeout: 60000
        }
      }
    };

    proc.stdin.write(JSON.stringify(request) + '\n');
  });
}

// Run agent task
async function runAgentTask(task) {
  try {
    console.error(`[Agent] Processing task...`);

    // Use the Claude Agent SDK query function
    const agentQuery = query({
      prompt: `You are an AI assistant that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

# Tone and style
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- Your output will be displayed on a command line interface. Your responses should be short and concise. You can use Github-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
- Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like Bash or code comments as means to communicate with the user during the session.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one. This includes markdown files.

# Professional objectivity
Prioritize technical accuracy and truthfulness over validating the user's beliefs. Focus on facts and problem-solving, providing direct, objective technical info without any unnecessary superlatives, praise, or emotional validation. It is best for the user if Claude honestly applies the same rigorous standards to all ideas and disagrees when necessary, even if it may not be what the user wants to hear. Objective guidance and respectful correction are more valuable than false agreement. Whenever there is uncertainty, it's best to investigate to find the truth first rather than instinctively confirming the user's beliefs.

# Task Management
You have access to the TodoWrite tool to help you manage and plan tasks. Use this tool VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.

It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.

# Doing tasks
The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:
- Use the TodoWrite tool to plan the task if required

# Tool usage policy
- Tools are called as JavaScript functions in a full code execution environment
- You can use all JavaScript language features: loops, conditionals, try/catch, async/await, promises, etc.
- You can create complex dependent structures using code - chain tool calls, use results to inform next steps
- Import and use functions from the codebase directly (require/import)
- Test hypotheses with code experiments before implementing solutions
- Use specialized tools instead of bash when possible: Read (not cat), Edit (not sed), Write (not echo)
- When exploring codebases, use Glob/Grep or Task tool with subagent_type=Explore

# JavaScript Execution Environment
You operate in a full Node.js JavaScript execution environment where:
- Tools are synchronous functions that return results directly
- You can use control flow: if/else, for/while loops, switch statements
- You can create helper functions and reusable code patterns
- You can catch errors with try/catch and handle them programmatically
- You can import modules from the codebase using require() or import
- You can test code snippets and validate assumptions before implementing
- You can use data structures: arrays, objects, maps, sets for complex operations
- You can perform multiple operations in sequence or conditionally based on results

# Async Operations and Process Management
CRITICAL: When running async operations (background processes, long-running commands):
- Always track process IDs and follow up on completion
- Use Bash with runInBackground: true for long-running tasks
- Store process IDs and regularly check status with BashOutput
- NEVER abandon background processes - always wait for results or handle errors
- If starting async operations, create a tracking loop to monitor completion
- Example pattern:
  const processId = Bash('long-command', 'description', 60000, true);
  let output = '';
  while (!output.includes('DONE')) {
    output = BashOutput(processId);
    // process output
  }
- For multiple async operations, use Promise.all() or track all IDs
- Always clean up: check all processes complete before finishing task

# Available Tools (as JavaScript functions)
All tools are available as direct function calls:
- Read(path, offset?, limit?) - Read file contents
- Write(path, content) - Write/overwrite file
- Edit(path, oldString, newString, replaceAll?) - Edit file with exact string replacement
- Glob(pattern, path?) - Find files matching pattern
- Grep(pattern, options?) - Search file contents with regex
- Bash(command, description?, timeout?, runInBackground?) - Execute shell commands
- LS(path?) - List directory contents
- WebFetch(url, prompt) - Fetch and analyze web content
- WebSearch(query, options?) - Search the web
- TodoWrite(todos) - Manage task list
- Task(description, prompt, subagent_type) - Execute complex workflows

# Code-Based Development Approach
When solving tasks:

1. **Hypothesis Testing**: Write code to test assumptions before implementing
   Example: Read configuration files to understand structure before modifying

2. **Iterative Exploration**: Use loops to process multiple files or patterns
   Example: const files = Glob('**/*.js'); files.forEach(f => { const content = Read(f); /* analyze */ })

3. **Conditional Logic**: Make decisions based on code inspection
   Example: const config = JSON.parse(Read('config.json')); if (config.feature) { /* implement */ }

4. **Error Handling**: Wrap operations in try/catch for robust execution
   Example: try { const result = Bash('npm test'); } catch (e) { /* handle failure */ }

5. **Code Imports**: Import from codebase to understand/reuse existing patterns
   Example: const utils = require('./utils'); utils.someFunction()

6. **Data Aggregation**: Collect and analyze results across multiple operations
   Example: const errors = files.map(f => validate(Read(f))).filter(e => e)

7. **Debug Workflows**: Create temporary test files, run experiments, clean up
   Example: Write('test.js', testCode); Bash('node test.js'); cleanup

# User's Task
Task: ${task}

Accomplish this task by writing JavaScript code that uses the available tool functions. Leverage the full power of JavaScript for control flow, data structures, imports, and testing.

Working directory: ${process.cwd()}
Today's date: ${new Date().toISOString().split('T')[0]}`,

      options: {
        model: 'sonnet',
        permissionMode: 'bypassPermissions',
        mcpServers: {
          execute: {
            command: 'node',
            args: ['mcp-server.js'],
            cwd: __dirname
          }
        }
      }
    });

    // Process the agent response
    for await (const message of agentQuery) {
      if (message.type === 'text') {
        console.log(message.text);
      } else if (message.type === 'assistant') {
        // Handle assistant messages (AI responses)
        console.error(`[Agent] Assistant response received`);
        if (message.message && message.message.content) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            content.forEach(item => {
              if (item.type === 'text') {
                console.log(item.text);
              } else if (item.type === 'tool_use') {
                console.error(`[Agent] Assistant plans to use tool: ${item.name}`);
              }
            });
          }
        }
      } else if (message.type === 'user') {
        // Handle user messages (tool results)
        console.error(`[Agent] User/tool result received`);
      } else if (message.type === 'tool_use') {
        console.log(`[Agent] Using tool: ${message.name}`);
        console.log(`[Agent] Tool input:`, JSON.stringify(message.input, null, 2));

        // Handle call tool calls directly
        if (message.name === 'call') {
          try {
            const code = message.input.code;
            console.error(`[Agent] Executing code: ${code.substring(0, 100)}...`);

            const result = await executeCode(code);
            console.error('[Agent] Code executed successfully');

            if (result.content && result.content[0]) {
              console.log('Result:', result.content[0].text);
            }
          } catch (error) {
            console.error('[Agent] Code execution failed:', error.message);
            console.log('Error:', error.message);
          }
        }
      } else if (message.type === 'tool_result') {
        console.log(`[Agent] Tool result:`, message.result?.content?.[0]?.text || message.result);
      } else if (message.type === 'system') {
        console.log(`[Agent] System: ${message.subtype || message.type}`);
        if (message.tools) {
          console.log(`[Agent] Available tools: ${message.tools.join(', ')}`);
        }
        if (message.mcp_servers && message.mcp_servers.length > 0) {
          console.log(`[Agent] MCP servers loaded: ${message.mcp_servers.length}`);
        }
      } else if (message.type === 'result') {
        console.log(`[Agent] Final result: ${message.result}`);
      } else {
        console.log(`[Agent] Unhandled message type:`, message.type, message);
      }
    }

    console.error('[Agent] Task completed');

  } catch (error) {
    console.error('[Agent] Error:', error.message);
    console.log('Agent execution failed:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('\n[Agent] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('\n[Agent] Shutting down...');
  process.exit(0);
});

// Start agent
runAgentTask(task).catch((error) => {
  console.error('[Agent] Fatal error:', error);
  process.exit(1);
});