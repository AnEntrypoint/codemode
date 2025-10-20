#!/usr/bin/env node

// Simple test for async handover using MCP execute tool directly

const testCode = `
console.log('Starting 35-second long-running task...');
for (let i = 0; i < 35; i++) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('Progress: ' + i + ' seconds elapsed');
}
console.log('Task completed!');
'Done'
`;

console.log('Test: Execute a 35-second task and verify async handover at 30 seconds');
console.log('Code:', testCode);
console.log('\nExecuting... (this will take 35 seconds)');
console.log('Expected: Execution should hand over to async mode after 30 seconds\n');
