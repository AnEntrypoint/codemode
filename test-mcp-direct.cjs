#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

console.log('Testing built-in-tools-mcp.js directly...\n');

// Test messages following MCP protocol
const messages = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  },
  {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'Write',
      arguments: {
        file_path: 'test-mcp-direct.txt',
        content: 'Hello from direct MCP test!'
      }
    }
  }
];

const child = spawn('node', ['built-in-tools-mcp.js'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
let messageIndex = 0;

child.stdout.on('data', (data) => {
  const chunk = data.toString();
  stdout += chunk;
  console.log('STDOUT:', chunk);
  
  // Send next message after getting response
  if (messageIndex < messages.length) {
    setTimeout(() => {
      const msg = messages[messageIndex];
      console.log('Sending:', JSON.stringify(msg, null, 2));
      child.stdin.write(JSON.stringify(msg) + '\n');
      messageIndex++;
    }, 100);
  }
});

child.stderr.on('data', (data) => {
  stderr += data.toString();
  console.log('STDERR:', data.toString());
});

child.on('spawn', () => {
  console.log('Process spawned, sending first message...');
  setTimeout(() => {
    const msg = messages[messageIndex];
    console.log('Sending:', JSON.stringify(msg, null, 2));
    child.stdin.write(JSON.stringify(msg) + '\n');
    messageIndex++;
  }, 100);
});

child.on('close', (code) => {
  console.log(`\nProcess exited with code: ${code}`);
  console.log('Final STDOUT:', stdout);
  console.log('Final STDERR:', stderr);
});

setTimeout(() => {
  child.kill();
  console.log('\nTimeout - killing process');
}, 10000);
