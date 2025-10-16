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
      prompt: `You are an AI agent with access to a call tool that can run JavaScript code with full file system and MCP tool access.

Available tools through call:
- Read, write, and edit files (Read, Write, Edit)
- Search files with patterns (Glob, Grep)
- Execute bash commands (Bash)
- List directories (LS)
- Access web content (WebFetch, WebSearch)
- Manage task lists (TodoWrite)
- Execute complex workflows (Task)
- All filesystem and code execution MCP tools
- GitHub CLI operations (gh command for repository management)

The call tool takes JavaScript code as input and returns the result.

Task: ${task}

Please accomplish this task by using the call tool. Write JavaScript code that uses the available functions to complete the task. Break down complex tasks into steps if needed.

Important: When using the call tool, wrap your JavaScript code in backticks and pass it as the 'code' parameter.`,

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
        console.log(`[Agent] Other message:`, message.type, message);
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