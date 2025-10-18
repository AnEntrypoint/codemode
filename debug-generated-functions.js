#!/usr/bin/env node

// Simple debug to see what functions are generated
// Let's just import the classes we need

const fs = await import('fs');
const path = await import('path');

async function debugGeneratedFunctions() {
  console.log('=== Debugging Generated MCP Functions ===\n');

  // Start the MCP server to see what tools it has
  const { spawn } = await import('child_process');

  const proc = spawn('node', ['built-in-tools-mcp.js'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let buffer = '';
  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          if (response.method === 'initialize') {
            // Send tools/list request
            proc.stdin.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/list'
            }) + '\n');
          } else if (response.id === 1 && response.result) {
            console.log('Available tools:');
            const tools = response.result.tools || [];
            tools.forEach(tool => {
              console.log(`- ${tool.name}: ${tool.description}`);
              console.log(`  Required: ${JSON.stringify(tool.inputSchema?.required || [])}`);
              console.log(`  Properties: ${JSON.stringify(Object.keys(tool.inputSchema?.properties || {}))}`);
              console.log('');
            });
            proc.kill();
            process.exit(0);
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      }
    }
  });

  proc.stderr.on('data', (data) => {
    console.error('stderr:', data.toString());
  });

  // Send initialize request
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'debug', version: '1.0.0' }
    }
  }) + '\n');
}

debugGeneratedFunctions().catch(console.error);