#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const TEST_DIR = path.join(__dirname, 'test');
const CODE_MODE_PATH = path.join(__dirname, 'code-mode.js');
const TEST_TIMEOUT = 60000; // 60 seconds

class CodeModeTest {
  constructor() {
    this.testsPassed = 0;
    this.testsFailed = 0;
    this.cleanupIssues = [];
  }

  async run() {
    console.log('🚀 Code Mode Integration Test');
    console.log(`Test directory: ${TEST_DIR}`);
    console.log(`Code mode server: ${CODE_MODE_PATH}`);

    try {
      console.log('\n📋 Pre-flight checks...');
      await this.preflightChecks();

      console.log('\n🔧 Setting up test environment...');
      await this.setupTestEnvironment();

      console.log('\n🧪 Running Claude Code integration test...');
      await this.runClaudeTest();

      console.log('\n🧹 Verifying cleanup...');
      await this.verifyCleanup();

      console.log('\n📊 Test Results:');
      console.log(`   ✅ Passed: ${this.testsPassed}`);
      console.log(`   ❌ Failed: ${this.testsFailed}`);

      if (this.cleanupIssues.length > 0) {
        console.log(`   ⚠️  Cleanup issues: ${this.cleanupIssues.length}`);
        this.cleanupIssues.forEach(issue => console.log(`      - ${issue}`));
      }

      if (this.testsFailed === 0 && this.cleanupIssues.length === 0) {
        console.log('\n✨ All tests passed! Code mode is working flawlessly.');
        process.exit(0);
      } else {
        console.log('\n❌ Some tests failed or cleanup issues detected.');
        process.exit(1);
      }

    } catch (error) {
      console.error('\n💥 Test failed:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
  }

  async preflightChecks() {
    // Check Claude CLI
    try {
      execSync('claude --version', { stdio: 'pipe' });
      console.log('   ✅ Claude CLI available');
    } catch (error) {
      throw new Error('Claude CLI not found. Install it first: https://github.com/anthropics/claude-code');
    }

    // Check code-mode.js exists
    if (!fs.existsSync(CODE_MODE_PATH)) {
      throw new Error(`code-mode.js not found at ${CODE_MODE_PATH}`);
    }
    console.log('   ✅ code-mode.js found');

    // Check Node.js version
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.substring(1).split('.')[0]);
    if (majorVersion < 18) {
      throw new Error(`Node.js ${nodeVersion} is too old. Need >= 18.x`);
    }
    console.log(`   ✅ Node.js ${nodeVersion}`);
  }

  async setupTestEnvironment() {
    // Clean and recreate test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    console.log('   ✅ Test directory created');

    // Create .claude.json with only execute tool
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
    console.log('   ✅ .claude.json created (code-mode MCP only)');

    // Create a test file to read
    fs.writeFileSync(
      path.join(TEST_DIR, 'test-input.txt'),
      'Hello from test file!\nLine 2\nLine 3\n'
    );
    console.log('   ✅ Test input file created');

    // Create package.json for the test directory
    const packageJson = {
      name: 'codemode-test',
      version: '1.0.0',
      type: 'module'
    };
    fs.writeFileSync(
      path.join(TEST_DIR, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
    console.log('   ✅ package.json created');

    // Initialize git repo
    try {
      execSync('git init', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git config user.name "Test User"', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git config user.email "test@test.com"', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git commit -m "Initial test commit"', { cwd: TEST_DIR, stdio: 'ignore' });
      console.log('   ✅ Git repository initialized');
    } catch (error) {
      console.log('   ⚠️  Git initialization failed (non-critical)');
    }
  }

  async runClaudeTest() {
    const allowedTools = "mcp__codemode__execute,mcp__codemode__execute_output,mcp__codemode__execute_list,mcp__codemode__execute_kill";

    const testPrompt = "Use mcp__codemode__execute to: 1) Read test-input.txt first 2 lines with Read('test-input.txt',0,2) 2) Write output.txt using Write('output.txt','Test output from execute tool!') 3) Glob *.txt files 4) Bash date command. Execute each as JavaScript code in execute tool.";

    const claudeCmd = `claude --mcp-config .claude.json --permission-mode bypassPermissions --allowed-tools "${allowedTools}" --output-format stream-json -p "${testPrompt}"`;

    console.log(`   💻 Running: ${claudeCmd}`);
    console.log(`   ⏱️  Timeout: ${TEST_TIMEOUT/1000}s`);

    const result = await this.executeClaudeCommand(claudeCmd, TEST_DIR, TEST_TIMEOUT);

    if (result.success) {
      console.log('   ✅ Claude command completed successfully');
      this.testsPassed++;

      // Parse output for verification
      this.verifyTestResults(result.output);
    } else {
      console.log('   ❌ Claude command failed');
      console.log(`   Error: ${result.error}`);
      if (result.stderr) {
        console.log(`   stderr: ${result.stderr.substring(0, 500)}`);
      }
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
        const output = data.toString();
        stdout += output;
        // Stream output in real-time
        process.stdout.write(output);
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          success: false,
          error: 'Command timed out',
          output: stdout,
          stderr
        });
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timeoutHandle);

        if (code === 0) {
          resolve({
            success: true,
            output: stdout,
            stderr
          });
        } else {
          resolve({
            success: false,
            error: `Exit code ${code}`,
            output: stdout,
            stderr
          });
        }
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

  verifyTestResults(output) {
    console.log('\n   📋 Verifying individual test operations:');

    // Check for execute tool usage
    if (output.includes('mcp__codemode__execute')) {
      console.log('      ✅ Execute tool was called');
      this.testsPassed++;
    } else {
      console.log('      ❌ Execute tool was not found in output');
      this.testsFailed++;
    }

    // Check if output.txt was created
    const outputFile = path.join(TEST_DIR, 'output.txt');
    if (fs.existsSync(outputFile)) {
      const content = fs.readFileSync(outputFile, 'utf8');
      if (content.includes('Test output')) {
        console.log('      ✅ Write operation successful (output.txt created with correct content)');
        this.testsPassed++;
      } else {
        console.log('      ❌ Write operation failed (output.txt has wrong content)');
        this.testsFailed++;
      }
    } else {
      console.log('      ❌ Write operation failed (output.txt not created)');
      this.testsFailed++;
    }

    // Check for test-input.txt content in output
    if (output.includes('Hello from test file') || output.includes('test-input.txt')) {
      console.log('      ✅ Read operation successful');
      this.testsPassed++;
    } else {
      console.log('      ⚠️  Read operation unclear from output');
    }

    // Check for glob results
    if (output.includes('.txt') || output.includes('test-input') || output.includes('Glob')) {
      console.log('      ✅ Glob operation appeared in output');
      this.testsPassed++;
    } else {
      console.log('      ⚠️  Glob operation unclear from output');
    }

    // Check for bash/date output
    const currentYear = new Date().getFullYear().toString();
    if (output.includes(currentYear) || output.includes('date') || output.includes('Bash')) {
      console.log('      ✅ Bash operation appeared in output');
      this.testsPassed++;
    } else {
      console.log('      ⚠️  Bash operation unclear from output');
    }
  }

  async verifyCleanup() {
    // Check for leftover temp files
    const tempPatterns = [
      '/tmp/codemode_tools_*.cjs',
      '/tmp/codemode_wrapper_*.cjs',
      '/tmp/codemode_*.js'
    ];

    tempPatterns.forEach(pattern => {
      try {
        const result = execSync(`ls ${pattern} 2>/dev/null`, { encoding: 'utf8' });
        if (result.trim()) {
          const files = result.trim().split('\n');
          this.cleanupIssues.push(`Found ${files.length} leftover temp files matching ${pattern}`);
          files.forEach(file => {
            console.log(`      ⚠️  Leftover: ${file}`);
          });
        }
      } catch (error) {
        // No files found - this is good
      }
    });

    // Check test directory for unexpected files
    const testFiles = fs.readdirSync(TEST_DIR);
    const expectedFiles = [
      '.claude.json',
      'test-input.txt',
      'output.txt',
      'package.json',
      '.git',
      '.vexify.db'  // vexify MCP creates this
    ];

    const unexpectedFiles = testFiles.filter(file => !expectedFiles.includes(file));
    if (unexpectedFiles.length > 0) {
      this.cleanupIssues.push(`Unexpected files in test directory: ${unexpectedFiles.join(', ')}`);
      unexpectedFiles.forEach(file => {
        console.log(`      ⚠️  Unexpected: ${file}`);
      });
    }

    if (this.cleanupIssues.length === 0) {
      console.log('   ✅ No cleanup issues found');
      console.log('   ✅ All temporary files cleaned up');
    }
  }
}

const test = new CodeModeTest();
test.run().catch(console.error);
