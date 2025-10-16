#!/usr/bin/env node

import { spawn } from 'child_process';

console.log('Testing Simple MCP Proxy...\n');

const proxyProcess = spawn('node', ['simple-mcp-proxy.js'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

let responseReceived = false;
let responseBuffer = '';

proxyProcess.stdout.on('data', (data) => {
  responseBuffer += data.toString();

  // Try to parse a complete JSON response
  const lines = responseBuffer.split('\n');
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        if (response.id === 1 && response.result) {
          console.log('✅ Received tools list response');
          console.log(`Found ${response.result.tools.length} tools:`);
          response.result.tools.forEach((tool, index) => {
            console.log(`  ${index + 1}. ${tool.name}: ${tool.description}`);
          });
          responseReceived = true;

          // Clean shutdown
          setTimeout(() => {
            proxyProcess.kill();
            process.exit(0);
          }, 1000);
        }
      } catch (e) {
        // Not a complete JSON yet
      }
    }
  }
});

// Wait for proxy to start, then send tools list request
setTimeout(() => {
  console.log('📤 Sending tools/list request...');
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  }) + '\n';

  proxyProcess.stdin.write(request);
}, 3000);

// Timeout after 10 seconds
setTimeout(() => {
  if (!responseReceived) {
    console.log('❌ No response received within timeout');
    console.log('Response buffer:', responseBuffer);
  } else {
    console.log('\n✅ Test completed successfully');
  }

  proxyProcess.kill();
  process.exit(responseReceived ? 0 : 1);
}, 10000);

proxyProcess.on('error', (error) => {
  console.error('❌ Failed to start proxy:', error.message);
  process.exit(1);
});