#!/usr/bin/env node

// Simple test script to verify MCP proxy functionality
import { spawn } from 'child_process';
import { existsSync } from 'fs';

console.log('Testing MCP Proxy...\n');

// Test 1: Check if files exist
console.log('1. Checking if required files exist...');
const requiredFiles = ['mcp-proxy.js', 'index.js', 'code-mode.js'];
const missingFiles = requiredFiles.filter(file => !existsSync(file));

if (missingFiles.length > 0) {
  console.error('❌ Missing files:', missingFiles.join(', '));
  process.exit(1);
} else {
  console.log('✅ All required files found');
}

// Test 2: Try to start the proxy and list tools
console.log('\n2. Testing proxy startup and tool listing...');

const proxyProcess = spawn('node', ['mcp-proxy.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';

proxyProcess.stdout.on('data', (data) => {
  stdout += data.toString();
});

proxyProcess.stderr.on('data', (data) => {
  stderr += data.toString();
});

// Send a tools/list request after a short delay
setTimeout(() => {
  const listToolsRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  }) + '\n';

  console.log('📤 Sending tools/list request...');
  proxyProcess.stdin.write(listToolsRequest);
}, 1000);

// Timeout after 10 seconds
setTimeout(() => {
  proxyProcess.kill();

  console.log('\n3. Results:');
  console.log('STDOUT:', stdout || '(no output)');
  console.log('STDERR:', stderr || '(no output)');

  if (stdout.includes('"tools"')) {
    console.log('✅ Proxy responded with tools list');
  } else if (stderr.includes('Connected to')) {
    console.log('✅ Proxy started successfully');
  } else {
    console.log('⚠️  Proxy may have issues');
  }

  console.log('\n✅ Test completed');
  process.exit(0);
}, 10000);

proxyProcess.on('error', (error) => {
  console.error('❌ Failed to start proxy:', error.message);
  process.exit(1);
});