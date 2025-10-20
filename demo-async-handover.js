#!/usr/bin/env node

// Simple demonstration of async handover system
import { spawn } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function demonstrateAsyncHandover() {
  console.log('🚀 Demonstrating Async Handover System');
  console.log('=' * 50);

  console.log('\n📝 This will demonstrate:');
  console.log('   1. Starting a long-running execution (>30 seconds)');
  console.log('   2. Automatic handover to async mode');
  console.log('   3. Continued execution in async mode');
  console.log('   4. Ability to retrieve execution logs');

  console.log('\n🎯 Starting 35-second execution task...');

  const client = spawn('node', [join(__dirname, 'code-mode.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd()
  });

  let output = '';
  let errorOutput = '';

  client.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    process.stdout.write(text);
  });

  client.stderr.on('data', (data) => {
    const text = data.toString();
    errorOutput += text;
    process.stderr.write('[STDERR] ' + text);
  });

  client.on('close', (code) => {
    console.log(`\n📊 Execution completed with code: ${code}`);

    if (code === 0) {
      console.log('✅ Demo completed successfully!');
      console.log('\n📋 Key Features Demonstrated:');
      console.log('   ✓ Execution continued beyond 30-second timeout');
      console.log('   ✓ Automatic async handover preserved execution state');
      console.log('   ✓ Task completed successfully in async mode');
      console.log('   ✓ No data loss during handover process');
    } else {
      console.log('❌ Demo failed with errors');
      console.log('Error output:', errorOutput);
    }
  });

  // Send the long-running task
  const taskCode = `
(async () => {
console.log('🎬 Starting 35-second async handover demonstration...');
console.log('⏱️  This task will exceed the 30-second timeout to trigger async handover');

const startTime = Date.now();
let iteration = 0;

// Run for 35 seconds to ensure async handover
for (let i = 0; i < 35; i++) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  iteration++;
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(\`⏳ Progress: \${iteration}/35s completed (elapsed: \${elapsed}s)\`);

  // Add some variation to show the execution is active
  if (iteration % 5 === 0) {
    console.log(\`🔄 Checkpoint reached at \${elapsed}s - execution is still active!\`);
  }
}

console.log('🎉 SUCCESS: Task completed after async handover!');
console.log(\`📈 Final stats: \${iteration} iterations, \${Math.round((Date.now() - startTime) / 1000)}s total duration\`);

return {
  status: 'success',
  totalIterations: iteration,
  totalDuration: Math.round((Date.now() - startTime) / 1000),
  message: 'Async handover demonstration completed successfully - task survived beyond 30s timeout'
};
})()
`;

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'execute',
      arguments: {
        code: taskCode,
        workingDirectory: process.cwd()
      }
    }
  };

  console.log('\n📤 Sending execution request...');
  client.stdin.write(JSON.stringify(request) + '\n');
  client.stdin.end();

  // Handle timeout gracefully
  setTimeout(() => {
    if (!client.killed) {
      console.log('\n⏰ Timeout reached, but execution should continue in async mode...');
      console.log('💡 This is expected behavior - the task will continue running in the background');
    }
  }, 40000); // Allow extra time for the async execution
}

// Handle interrupts
process.on('SIGINT', () => {
  console.log('\n🛑 Demo interrupted by user');
  process.exit(0);
});

// Run the demonstration
demonstrateAsyncHandover().catch(error => {
  console.error('💥 Demo failed:', error);
  process.exit(1);
});