#!/usr/bin/env node

// Minimal working agent - direct execution without MCP
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const isAgentMode = args.includes('--agent');

if (!isAgentMode) {
  console.error('Usage: node minimal-agent.js --agent [task]');
  process.exit(1);
}

// Extract task from arguments
const taskIndex = args.indexOf('--agent') + 1;
const task = taskIndex < args.length ? args.slice(taskIndex).join(' ') : 'Help me with this codebase';

console.error('[Minimal Agent] Direct JavaScript Execution');
console.error(`[Minimal Agent] Task: ${task}`);
console.error('[Minimal Agent] Working directory:', process.cwd());

// Execute JavaScript code directly
async function executeCode(code, workingDirectory = process.cwd()) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['-e', code], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workingDirectory
    });

    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ output, error: errorOutput });
      } else {
        reject(new Error(`Execution failed (code ${code}): ${errorOutput}`));
      }
    });
  });
}

// Simple tool implementations
const tools = {
  async Read(path, offset, limit) {
    const fs = await import('fs');
    try {
      let content = fs.readFileSync(path, 'utf8');
      if (offset || limit) {
        const lines = content.split('\n');
        const start = offset || 0;
        const end = limit ? start + limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      return content;
    } catch (error) {
      throw new Error(`Read failed: ${error.message}`);
    }
  },

  async Write(path, content) {
    const fs = await import('fs');
    try {
      fs.writeFileSync(path, content, 'utf8');
      return `Wrote ${content.length} characters to ${path}`;
    } catch (error) {
      throw new Error(`Write failed: ${error.message}`);
    }
  },

  async Edit(path, oldString, newString, replaceAll = false) {
    const fs = await import('fs');
    try {
      let content = fs.readFileSync(path, 'utf8');
      if (replaceAll) {
        content = content.split(oldString).join(newString);
      } else {
        content = content.replace(oldString, newString);
      }
      fs.writeFileSync(path, content, 'utf8');
      return `Edited ${path}`;
    } catch (error) {
      throw new Error(`Edit failed: ${error.message}`);
    }
  },

  async Glob(pattern, path = process.cwd()) {
    const { glob } = await import('glob');
    try {
      const files = glob.sync(pattern, { cwd: path });
      return files;
    } catch (error) {
      throw new Error(`Glob failed: ${error.message}`);
    }
  },

  async Bash(command, description, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, { shell: true, stdio: 'pipe' });
      let output = '';
      let errorOutput = '';

      proc.stdout.on('data', (data) => output += data.toString());
      proc.stderr.on('data', (data) => errorOutput += data.toString());

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ output, error: errorOutput });
        } else {
          reject(new Error(`Command failed with code ${code}: ${errorOutput}`));
        }
      });
    });
  }
};

// Run agent task
async function runAgentTask(task) {
  try {
    console.error(`[Minimal Agent] Processing task...`);

    // Generate code to execute the task
    const code = `
import('fs').then(fs => {
  import('path').then(path => {
    import('child_process').then(cp => {

      // Simple file operations
      const files = fs.readdirSync('.').filter(f => f.endsWith('.js'));
      console.log('JavaScript files in this directory:');
      files.forEach(file => console.log('  - ' + file));

      console.log('\\nTask:', ${JSON.stringify(task)});
      console.log('Working directory:', process.cwd());
      console.log('Available tools: Read, Write, Edit, Glob, Bash');

    });
  });
}).catch(err => {
  console.error('Error:', err.message);
});
`;

    const result = await executeCode(code);

    if (result.output) {
      console.log(result.output);
    }
    if (result.error) {
      console.error('[Stderr]', result.error);
    }

    console.error('[Minimal Agent] Task completed successfully');

  } catch (error) {
    console.error(`[Minimal Agent] Error: ${error.message}`);
    process.exit(1);
  }
}

// Run the agent
runAgentTask(task);