#!/usr/bin/env node

// Agent using Claude Agent SDK with stdio MCP server
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

// Session start hooks
async function runSessionStartHooks() {
  const hooks = [
    'curl -s https://raw.githubusercontent.com/AnEntrypoint/glootie-cc/refs/heads/master/start.md',
    'npx -y mcp-thorns@latest',
    'npx -y wfgy@latest hook'
  ];

  for (const hook of hooks) {
    try {
      console.error(`[Hook] ${hook}`);
      spawn('bash', ['-c', hook], { stdio: 'inherit' });
    } catch (e) {
      console.error(`[Hook] Failed: ${e.message}`);
    }
  }
}

// Process monitor for stuck operations
const activeProcesses = new Set();
const processStartTimes = new Map();
const MAX_PROCESS_TIME = 300000; // 5 minutes

function monitorProcesses() {
  const now = Date.now();
  for (const [pid, startTime] of processStartTimes.entries()) {
    if (now - startTime > MAX_PROCESS_TIME) {
      console.error(`[Monitor] Killing stuck process: ${pid}`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {}
      processStartTimes.delete(pid);
      activeProcesses.delete(pid);
    }
  }
}

setInterval(monitorProcesses, 10000); // Check every 10s

// Run agent task
async function runAgentTask(task) {
  try {
    console.error(`[Agent] Processing task...`);
    await runSessionStartHooks();

    const agentQuery = query({
      prompt: `AI assistant for software engineering tasks. Tools are JavaScript functions in Node.js environment.

# Style
No emojis unless requested. Concise CLI output. Use tools only for actions, text for communication. Prefer editing files over creating new ones.

# Objectivity
Prioritize accuracy over validation. Challenge assumptions. Investigate truth before confirming beliefs.

# Task Management
Use TodoWrite frequently for planning/tracking. Mark completed immediately, one at a time.

# JS Environment
Tools are sync functions returning results. Use all JS features: loops, conditionals, try/catch, require/import, helpers, data structures. Tools execute in single context - variables persist within one call only.

# Tools (functions)
Read(path,offset?,limit?), Write(path,content), Edit(path,old,new,replaceAll?), Glob(pattern,path?), Grep(pattern,opts?), Bash(cmd,desc?,timeout?,bg?), LS(path?), WebFetch(url,prompt), WebSearch(query,opts?), TodoWrite(todos), Task(desc,prompt,type), BashOutput(id,filter?), KillShell(id)

# Patterns
1. Test hypotheses: Read configs to understand before modifying
2. Iterate: files.forEach(f=>analyze(Read(f)))
3. Conditional: if(JSON.parse(Read('x.json')).feature){...}
4. Errors: try{op}catch(e){report to user}
5. Imports: require('./module') to reuse patterns
6. Aggregate: files.map(f=>validate(Read(f))).filter(Boolean)
7. Debug: Write temp files, test, cleanup

# Critical Caveats
- Variables don't persist between tool calls - complete work in single call
- Wrap JSON.parse in try/catch always
- Edit fails on non-unique strings - provide more context or use replaceAll
- Limit Glob results - check length before processing all
- Use absolute paths always - relative paths unreliable
- Validate operations succeeded - check return values
- Report all errors to user explicitly
- Loop safety: add iteration counters, break conditions
- File size: check before reading large files (use offset/limit for >1MB)
- Binary files: don't read as text

# Async Process Management
CRITICAL: Background processes must be tracked and monitored:
- Track: const id=Bash(cmd,'desc',timeout,true); processIds.push(id);
- Monitor: setInterval to check BashOutput(id)
- Timeout: kill if stuck >2min: KillShell(id)
- Never abandon processes - always wait or kill
- Pattern: while(true){const out=BashOutput(id); if(out.includes('DONE')||iterations++>100)break;}
- Cleanup: KillShell for all tracked IDs before finishing

# Task
${task}

Write JS code using tool functions. Use loops/conditionals/imports/testing. Validate results. Report errors.

CWD: ${process.cwd()}
Date: ${new Date().toISOString().split('T')[0]}`,

      options: {
        model: 'sonnet',
        permissionMode: 'bypassPermissions',
        allowedTools: ['mcp__execute__call'],
        disallowedTools: [
          'Task', 'Bash', 'Glob', 'Grep', 'ExitPlanMode', 'Read', 'Edit', 'Write',
          'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'BashOutput', 'KillShell', 'SlashCommand'
        ],
        mcpServers: {
          execute: {
            type: 'stdio',
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