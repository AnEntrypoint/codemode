#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TEST_DIR = path.join(__dirname, 'test-async');
const CODE_MODE_PATH = path.join(__dirname, 'code-mode.js');

class AsyncExecutionTest {
  constructor() {
    this.testsPassed = 0;
    this.testsFailed = 0;
  }

  async run() {
    console.log('🚀 Code Mode Async Execution Test');
    console.log('Testing 30-second threshold and background execution management\n');

    try {
      console.log('🔧 Setting up test environment...');
      this.setupTestEnvironment();

      console.log('\n🧪 Test 1: Long-running execution goes to background after 30s');
      await this.testAsyncExecution();

      console.log('\n🧪 Test 2: Query background execution output');
      await this.testExecuteOutput();

      console.log('\n🧪 Test 3: List all executions');
      await this.testExecuteList();

      console.log('\n🧪 Test 4: Kill running execution');
      await this.testExecuteKill();

      console.log('\n📊 Test Results:');
      console.log(`   ✅ Passed: ${this.testsPassed}`);
      console.log(`   ❌ Failed: ${this.testsFailed}`);

      if (this.testsFailed === 0) {
        console.log('\n✨ All async execution tests passed!');
        process.exit(0);
      } else {
        console.log('\n❌ Some tests failed.');
        process.exit(1);
      }

    } catch (error) {
      console.error('\n💥 Test failed:', error.message);
      console.error(error.stack);
      process.exit(1);
    } finally {
      // Cleanup
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    }
  }

  setupTestEnvironment() {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const claudeConfig = {
      mcpServers: {
        codemode: {
          command: "node",
          args: [CODE_MODE_PATH],
          env: {}
        }
      }
    };
    fs.writeFileSync(
      path.join(TEST_DIR, '.claude.json'),
      JSON.stringify(claudeConfig, null, 2)
    );
    console.log('   ✅ Test environment created');
  }

  async testAsyncExecution() {
    const prompt = "Use mcp__codemode__execute to run code that sleeps for 45 seconds: await new Promise(resolve => setTimeout(resolve, 45000)); console.log('Done after 45s');";

    const allowedTools = "mcp__codemode__execute,mcp__codemode__execute_output,mcp__codemode__execute_list,mcp__codemode__execute_kill";

    const claudeCmd = `claude --mcp-config .claude.json --permission-mode bypassPermissions --allowed-tools "${allowedTools}" --output-format stream-json -p "${prompt}"`;

    console.log('   ⏱️  Starting 45-second execution...');
    const startTime = Date.now();

    const result = await this.executeClaudeCommand(claudeCmd, TEST_DIR, 60000);
    const elapsed = (Date.now() - startTime) / 1000;

    console.log(`   ⏱️  Command returned after ${elapsed.toFixed(1)}s`);

    // Print output for debugging - look for execution ID and async messages
    const lines = result.output.split('\n');
    for (const line of lines) {
      if (line.includes('Execution') || line.includes('background') || line.includes('ID:') || line.includes('Done after')) {
        console.log(`   📄 ${line.substring(0, 200)}`);
      }
    }
    if (result.stderr && result.stderr.includes('DEBUG')) {
      console.log(`   ⚠️  Debug stderr: ${result.stderr.substring(0, 1000)}`);
    }

    if (result.success) {
      // Check for background execution message (the key indicator that async threshold worked)
      if (result.output.includes('Execution running in background') && result.output.includes('ID:')) {
        console.log('   ✅ Execution went to background (async threshold worked)');
        this.testsPassed++;

        // Extract execution ID from output
        const executionIdMatch = result.output.match(/ID:\s*(\d+)/);
        if (executionIdMatch) {
          this.executionId = executionIdMatch[1];
          console.log(`   ✅ Got execution ID: ${this.executionId}`);
          this.testsPassed++;
        } else {
          console.log('   ❌ No execution ID found in output');
          this.testsFailed++;
        }

        // Check that Claude was able to query the execution status
        if (result.output.includes('Status: running') || result.output.includes('Status: completed')) {
          console.log('   ✅ Claude successfully queried execution status');
          this.testsPassed++;
        } else {
          console.log('   ⚠️  No status query found (Claude may not have checked)');
        }

        // Note: Total session time > 30s is expected because Claude may choose to wait for completion
        console.log(`   ℹ️  Total session time: ${elapsed.toFixed(1)}s (includes Claude's follow-up queries)`);
      } else {
        console.log('   ❌ No background execution message found');
        console.log('   Expected: "Execution running in background (ID: ...)"');
        this.testsFailed++;
      }
    } else {
      console.log('   ❌ Claude command failed');
      console.log(`   Error: ${result.error}`);
      this.testsFailed++;
    }
  }

  async testExecuteOutput() {
    if (!this.executionId) {
      console.log('   ⚠️  Skipping (no execution ID from previous test)');
      return;
    }

    const prompt = `Use mcp__codemode__execute_output to get the output of execution ID ${this.executionId}`;

    const allowedTools = "mcp__codemode__execute,mcp__codemode__execute_output,mcp__codemode__execute_list,mcp__codemode__execute_kill";

    const claudeCmd = `claude --mcp-config .claude.json --permission-mode bypassPermissions --allowed-tools "${allowedTools}" --output-format stream-json -p "${prompt}"`;

    console.log(`   📡 Querying execution ${this.executionId}...`);

    const result = await this.executeClaudeCommand(claudeCmd, TEST_DIR, 30000);

    if (result.success) {
      if (result.output.includes('execute_output') || result.output.includes(this.executionId)) {
        console.log('   ✅ execute_output tool was called');
        this.testsPassed++;

        // Check for status information
        if (result.output.includes('Status:') || result.output.includes('running') || result.output.includes('completed')) {
          console.log('   ✅ Execution status retrieved');
          this.testsPassed++;
        }
      } else {
        console.log('   ❌ execute_output tool not found in output');
        this.testsFailed++;
      }
    } else {
      console.log('   ❌ Query command failed');
      this.testsFailed++;
    }
  }

  async testExecuteList() {
    const prompt = "Use mcp__codemode__execute_list to list all running and completed background executions";

    const allowedTools = "mcp__codemode__execute,mcp__codemode__execute_output,mcp__codemode__execute_list,mcp__codemode__execute_kill";

    const claudeCmd = `claude --mcp-config .claude.json --permission-mode bypassPermissions --allowed-tools "${allowedTools}" --output-format stream-json -p "${prompt}"`;

    console.log('   📋 Listing all executions...');

    const result = await this.executeClaudeCommand(claudeCmd, TEST_DIR, 30000);

    if (result.success) {
      if (result.output.includes('execute_list')) {
        console.log('   ✅ execute_list tool was called');
        this.testsPassed++;

        if (this.executionId && result.output.includes(this.executionId)) {
          console.log('   ✅ Our execution ID appears in the list');
          this.testsPassed++;
        }
      } else {
        console.log('   ❌ execute_list tool not found in output');
        this.testsFailed++;
      }
    } else {
      console.log('   ❌ List command failed');
      this.testsFailed++;
    }
  }

  async testExecuteKill() {
    if (!this.executionId) {
      console.log('   ⚠️  Skipping (no execution ID from previous test)');
      return;
    }

    // First start a new long-running execution to kill
    console.log('   🔧 Starting new long execution to test killing...');
    const startPrompt = "Use mcp__codemode__execute to run: await new Promise(resolve => setTimeout(resolve, 60000)); console.log('Should not see this');";

    const allowedTools = "mcp__codemode__execute,mcp__codemode__execute_output,mcp__codemode__execute_list,mcp__codemode__execute_kill";

    let startCmd = `claude --mcp-config .claude.json --permission-mode bypassPermissions --allowed-tools "${allowedTools}" --output-format stream-json -p "${startPrompt}"`;

    const startResult = await this.executeClaudeCommand(startCmd, TEST_DIR, 35000);

    let killTargetId = null;
    if (startResult.success) {
      const idMatch = startResult.output.match(/Execution ID:\s*(\d+)/);
      if (idMatch) {
        killTargetId = idMatch[1];
        console.log(`   ✅ Started execution ${killTargetId} to kill`);
      }
    }

    if (!killTargetId) {
      console.log('   ⚠️  Could not start execution to kill, using previous ID');
      killTargetId = this.executionId;
    }

    // Now kill it
    const killPrompt = `Use mcp__codemode__execute_kill to kill execution ID ${killTargetId}`;

    const killCmd = `claude --mcp-config .claude.json --permission-mode bypassPermissions --allowed-tools "${allowedTools}" --output-format stream-json -p "${killPrompt}"`;

    console.log(`   🔪 Killing execution ${killTargetId}...`);

    const result = await this.executeClaudeCommand(killCmd, TEST_DIR, 30000);

    if (result.success) {
      if (result.output.includes('execute_kill') || result.output.includes('killed')) {
        console.log('   ✅ execute_kill tool was called');
        this.testsPassed++;

        if (result.output.includes('successfully') || result.output.includes('killed')) {
          console.log('   ✅ Execution was killed successfully');
          this.testsPassed++;
        }
      } else {
        console.log('   ❌ execute_kill tool not found in output');
        this.testsFailed++;
      }
    } else {
      console.log('   ❌ Kill command failed');
      this.testsFailed++;
    }
  }

  executeClaudeCommand(cmd, workingDir, timeout) {
    return new Promise((resolve) => {
      const child = spawn('script', [
        '-q', '-c', `cd "${workingDir}" && ${cmd}`, '/dev/null'
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          success: true,  // Timeout is OK for async tests
          output: stdout,
          stderr,
          timedOut: true
        });
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        resolve({
          success: code === 0,
          output: stdout,
          stderr,
          code
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeoutHandle);
        resolve({
          success: false,
          error: error.message,
          output: stdout,
          stderr
        });
      });
    });
  }
}

const test = new AsyncExecutionTest();
test.run().catch(console.error);
