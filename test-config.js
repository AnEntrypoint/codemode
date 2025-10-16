#!/usr/bin/env node

import { spawn } from 'child_process';

console.log('Testing proxy with .codemode.json config...\n');

const proxy = spawn('node', ['proxy.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: process.cwd()
});

proxy.stdout.on('data', (data) => {
  try {
    const response = JSON.parse(data.toString());
    if (response.result && response.result.tools) {
      console.log(`✅ Success! Found ${response.result.tools.length} tools`);
      console.log('Sample tools:');
      response.result.tools.slice(0, 5).forEach(tool => {
        console.log(`  - ${tool.name}`);
      });

      setTimeout(() => {
        proxy.kill();
        process.exit(0);
      }, 1000);
    }
  } catch (e) {
    // ignore parse errors
  }
});

// Send tools list request
setTimeout(() => {
  proxy.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  }) + '\n');
}, 2000);

setTimeout(() => {
  console.log('❌ Test timeout');
  proxy.kill();
  process.exit(1);
}, 5000);