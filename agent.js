#!/usr/bin/env node

import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const isAgentMode = args.includes('--agent');

if (!isAgentMode) {
  console.error('Usage: node agent.js --agent [task]');
  console.error('       codemode --agent [task]');
  process.exit(1);
}

const taskIndex = args.indexOf('--agent') + 1;
const task = taskIndex < args.length ? args.slice(taskIndex).join(' ') : 'Help me with this codebase';

console.error('[Agent] Starting Claude Code Agent');
console.error(`[Agent] Task: ${task}`);
console.error('[Agent] Working directory:', process.cwd());

console.error('[Agent] Fetching additional tool documentation...');
let additionalTools = '';
try {
  const startMd = execSync('curl -s https://raw.githubusercontent.com/AnEntrypoint/glootie-cc/refs/heads/master/start.md', { encoding: 'utf8' });
  const mcpThorns = execSync('npx -y mcp-thorns@latest', { encoding: 'utf8' });
  const wfgyHook = execSync('npx -y wfgy@latest hook', { encoding: 'utf8' });
  additionalTools = `\n\n# Additional Tool Documentation\n\n${startMd}\n\n${mcpThorns}\n\n${wfgyHook}`;
  console.error('[Agent] Additional tools loaded');
} catch (error) {
  console.error('[Agent] Warning: Failed to fetch additional tools:', error.message);
}

const agentPrompt = `You are an AI assistant with access to an execute tool that allows you to run JavaScript code programmatically.

# Available Functions via Execute Tool

The execute tool provides these functions that you can call in your JavaScript code:

## File Operations
- Read(path, offset?, limit?) - Read file content with optional offset and limit
- Write(path, content) - Write content to file
- Edit(path, oldString, newString, replaceAll?) - Edit file by replacing strings
- Glob(pattern, path?) - Find files matching glob pattern

## Search Operations
- Grep(pattern, path?, options?) - Search for pattern in files using ripgrep
  Options: {glob, type, output_mode, '-i', '-n', '-A', '-B', '-C', multiline, head_limit}

## System Operations
- Bash(command, description?, timeout?) - Execute shell command
- LS(path?, show_hidden?, recursive?) - List directory contents

## Web Operations
- WebFetch(url, prompt) - Fetch and analyze web content
- WebSearch(query, allowed_domains?, blocked_domains?) - Search the web

## Task Management
- TodoWrite(todos) - Write todo list
  Format: [{content, status, activeForm}] where status is 'pending'|'in_progress'|'completed'

## MCP Tools (from configured servers)
All MCP tools from glootie, playwright, and vexify are also available as functions.
Use browser automation, code analysis, and semantic search tools as needed.

# Instructions

- Use the execute tool to run JavaScript code with these functions available
- You can call functions programmatically - no need for linear tool-by-tool execution
- Write code that completes the entire task in one execution
- Use async/await for async operations
- Show progress with console.log
- Focus on completing the user's task efficiently

# Task
${task}

# Context
Working directory: ${process.cwd()}
Date: ${new Date().toISOString().split('T')[0]}${additionalTools}`;

async function runAgent() {
  try {
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

    for await (const message of agentQuery) {
      if (message.type === 'text') {
        console.log(message.text);
      } else if (message.type === 'assistant') {
        if (message.message && message.message.content) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            content.forEach(item => {
	      //console.log(item);    
              if (item.type === 'text') {
                console.log(item.text);
              } else if(item.type === 'code') {
		console.log('---RUN---');
		console.log(item.code);
		console.log('---------');
	      }
            });
          }
        }
      }
    }

    console.error('[Agent] Task completed');

  } catch (error) {
    console.error(`[Agent] Error: ${error.message}`);
    process.exit(1);
  }
}

runAgent();
