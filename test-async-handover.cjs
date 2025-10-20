#!/usr/bin/env node

// Test async handover, progressive streaming, and interactive sessions

const { spawn } = require('child_process');
const { readFileSync } = require('fs');

console.log('[Test] Starting async handover and interactive session tests...\n');

// Test 1: Async handover after 30 seconds
console.log('[Test 1] Testing automatic async handover after 30 seconds...');

const proc1 = spawn('node', ['code-mode.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let proc1Output = '';
proc1.stdout.on('data', (data) => {
  proc1Output += data.toString();
  process.stdout.write('[Test 1 stdout] ' + data.toString());
});

proc1.stderr.on('data', (data) => {
  process.stderr.write('[Test 1 stderr] ' + data.toString());
});

proc1.on('error', (err) => {
  console.error('[Test 1] Error:', err);
});

// Wait for server to initialize
setTimeout(() => {
  console.log('[Test 1] Sending initialize request...');

  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  };

  proc1.stdin.write(JSON.stringify(initRequest) + '\n');

  setTimeout(() => {
    console.log('[Test 1] Sending tools/list request...');

    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    };

    proc1.stdin.write(JSON.stringify(toolsRequest) + '\n');

    setTimeout(() => {
      console.log('[Test 1] Sending execute request with 35 second long-running task...');

      // This will run for 35 seconds, triggering async handover at 30 seconds
      const executeRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'execute',
          arguments: {
            workingDirectory: process.cwd(),
            code: `
              console.log('Starting long-running task...');
              for (let i = 0; i < 35; i++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                console.log('Progress: ' + i + ' seconds elapsed');
              }
              console.log('Task completed!');
              'Done'
            `
          }
        }
      };

      proc1.stdin.write(JSON.stringify(executeRequest) + '\n');

      // Check for async handover message after 31 seconds
      setTimeout(() => {
        console.log('[Test 1] Checking for async handover...');
        if (proc1Output.includes('Execution moved to async mode')) {
          console.log('[Test 1] ✓ Async handover detected!');
        } else {
          console.log('[Test 1] ✗ Async handover NOT detected - output:', proc1Output.substring(0, 500));
        }

        // Test retrieving async log
        console.log('[Test 1] Testing get_async_log action...');
        const getAsyncLogRequest = {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'execute',
            arguments: {
              action: 'get_async_log',
              executionId: '0' // First execution ID
            }
          }
        };

        proc1.stdin.write(JSON.stringify(getAsyncLogRequest) + '\n');

        setTimeout(() => {
          console.log('[Test 1] Test complete - killing process');
          proc1.kill();
        }, 3000);
      }, 31000);
    }, 2000);
  }, 2000);
}, 3000);

// Test 2: Progressive streaming
setTimeout(() => {
  console.log('\n[Test 2] Testing progressive stdout streaming...');

  const proc2 = spawn('node', ['code-mode.js'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let streamedMessages = 0;
  proc2.stdout.on('data', (data) => {
    const output = data.toString();
    process.stdout.write('[Test 2 stdout] ' + output);

    // Count streamed log messages
    const matches = output.match(/Progress:/g);
    if (matches) {
      streamedMessages += matches.length;
    }
  });

  proc2.stderr.on('data', (data) => {
    process.stderr.write('[Test 2 stderr] ' + data.toString());
  });

  setTimeout(() => {
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    };

    proc2.stdin.write(JSON.stringify(initRequest) + '\n');

    setTimeout(() => {
      const executeRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'execute',
          arguments: {
            workingDirectory: process.cwd(),
            code: `
              for (let i = 0; i < 10; i++) {
                await new Promise(resolve => setTimeout(resolve, 500));
                console.log('Progress: ' + i);
              }
              'Done streaming'
            `
          }
        }
      };

      proc2.stdin.write(JSON.stringify(executeRequest) + '\n');

      setTimeout(() => {
        console.log(`[Test 2] Streamed ${streamedMessages} messages`);
        if (streamedMessages >= 10) {
          console.log('[Test 2] ✓ Progressive streaming working!');
        } else {
          console.log('[Test 2] ✗ Progressive streaming incomplete');
        }
        proc2.kill();
      }, 7000);
    }, 2000);
  }, 3000);
}, 45000);

// Test 3: Interactive session detection
setTimeout(() => {
  console.log('\n[Test 3] Testing interactive session detection...');

  const proc3 = spawn('node', ['code-mode.js'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let detectedInteractive = false;
  proc3.stderr.on('data', (data) => {
    const output = data.toString();
    process.stderr.write('[Test 3 stderr] ' + output);

    if (output.includes('Session is now interactive')) {
      detectedInteractive = true;
      console.log('[Test 3] ✓ Interactive session detected!');
    }
  });

  proc3.stdout.on('data', (data) => {
    process.stdout.write('[Test 3 stdout] ' + data.toString());
  });

  setTimeout(() => {
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    };

    proc3.stdin.write(JSON.stringify(initRequest) + '\n');

    setTimeout(() => {
      const executeRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'execute',
          arguments: {
            workingDirectory: process.cwd(),
            code: `
              console.log('Waiting for stdin...');
              const input = await readStdin(0);
              console.log('Received:', input);
              input
            `
          }
        }
      };

      proc3.stdin.write(JSON.stringify(executeRequest) + '\n');

      // Send stdin data to trigger interactive mode
      setTimeout(() => {
        console.log('[Test 3] Sending stdin data...');
        const stdinRequest = {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'execute',
            arguments: {
              action: 'send_stdin',
              executionId: '0',
              stdinData: 'Hello from test!'
            }
          }
        };

        proc3.stdin.write(JSON.stringify(stdinRequest) + '\n');

        setTimeout(() => {
          if (detectedInteractive) {
            console.log('[Test 3] ✓ Interactive session test passed!');
          } else {
            console.log('[Test 3] ✗ Interactive session not detected');
          }
          proc3.kill();

          console.log('\n[All Tests] Complete!');
          process.exit(0);
        }, 3000);
      }, 2000);
    }, 2000);
  }, 3000);
}, 60000);
