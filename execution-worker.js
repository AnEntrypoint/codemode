#!/usr/bin/env node

// Persistent execution context worker
// Communicates with parent via IPC for MCP tool calls

import { createRequire } from 'module';

// Initialize global scope for user code
// Note: These will be set to the actual workingDirectory when code executes
global.require = null;
global.__filename = null;
global.__dirname = null;
global.module = { exports: {} };
global.exports = global.module.exports;

const pendingMCPCalls = new Map();
let nextCallId = 0;

// Persistent execution context - maintains state across all executions
// All user code shares this context for variable persistence
const persistentContext = {};

// Capture console output
let capturedOutput = '';
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function startCapture(execId) {
  capturedOutput = '';

  console.log = (...args) => {
    const msg = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    capturedOutput += msg + '\n';
    originalConsoleLog(...args);

    // Stream output in real-time
    if (execId !== undefined) {
      process.send({ type: 'STREAM_OUTPUT', execId, output: msg });
    }
  };

  console.error = (...args) => {
    const msg = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    capturedOutput += msg + '\n';
    originalConsoleError(...args);

    // Stream output in real-time
    if (execId !== undefined) {
      process.send({ type: 'STREAM_OUTPUT', execId, output: msg });
    }
  };

  console.warn = (...args) => {
    const msg = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    capturedOutput += msg + '\n';
    originalConsoleWarn(...args);

    // Stream output in real-time
    if (execId !== undefined) {
      process.send({ type: 'STREAM_OUTPUT', execId, output: msg });
    }
  };
}

function stopCapture() {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  return capturedOutput;
}

// Handle messages from parent
process.on('message', (msg) => {
  if (msg.type === 'MCP_RESULT') {
    const { callId, success, result } = msg;
    if (pendingMCPCalls.has(callId)) {
      const { resolve, reject } = pendingMCPCalls.get(callId);
      pendingMCPCalls.delete(callId);

      if (success) {
        resolve(result);
      } else {
        reject(new Error(result));
      }
    }
  } else if (msg.type === 'EXECUTE') {
    const { execId, code, workingDirectory } = msg;

    (async () => {
      startCapture(execId);
      try {
        process.chdir(workingDirectory);

        // Update context variables for current working directory
        global.__workingDirectory = workingDirectory;
        global.__dirname = workingDirectory;
        global.__filename = workingDirectory + '/[execute]';

        // Create a scoped require for the working directory
        const scopedRequire = createRequire(workingDirectory + '/package.json');
        global.require = scopedRequire;

        // Execute code in persistent context
        // Copy persistent context to global scope, skipping read-only properties
        for (const key in persistentContext) {
          try {
            global[key] = persistentContext[key];
          } catch (e) {
            // Skip read-only properties like 'navigator'
          }
        }

        // Execute the code with smart return value handling
        // Strategy: Try multiple approaches to capture the result
        let result;

        // Strategy 1: Try as pure expression (fastest for simple cases)
        try {
          result = await eval(`(async () => { return (${code}); })()`);
        } catch (expressionError) {
          // Strategy 2: Try to intelligently wrap the code
          // Check if code has multiple statements by looking for semicolons or newlines
          const trimmedCode = code.trim();
          const hasMultipleStatements = trimmedCode.includes(';') || trimmedCode.includes('\n');

          if (hasMultipleStatements) {
            // Strategy 2a: For multi-statement code, try to extract and return last expression
            // Split by semicolons and newlines to find statements
            const lines = trimmedCode.split(/[;\n]/).map(l => l.trim()).filter(l => l.length > 0);

            if (lines.length > 0) {
              const lastLine = lines[lines.length - 1];
              const previousLines = lines.slice(0, -1).join(';\n');

              // Check if last line looks like an expression (not a declaration/control flow)
              const isDeclaration = /^(const|let|var|function|class|if|for|while|do|switch|try)\s/.test(lastLine);

              if (!isDeclaration && previousLines) {
                // Try executing all but last line, then return last line
                try {
                  result = await eval(`(async () => { ${previousLines}; return (${lastLine}); })()`);
                } catch (splitError) {
                  // If that fails, execute all as statements
                  result = await eval(`(async () => { ${code} })()`);
                }
              } else {
                // Last line is a declaration or no previous lines, execute as-is
                result = await eval(`(async () => { ${code} })()`);
              }
            } else {
              result = await eval(`(async () => { ${code} })()`);
            }
          } else {
            // Strategy 2b: Single statement, execute as-is
            result = await eval(`(async () => { ${code} })()`);
          }
        }

        // Save any new global variables back to persistent context
        // Only save variables that aren't system properties
        const systemProps = new Set([
          '__filename', '__dirname', 'module', 'exports', 'require',
          'console', 'process', 'Buffer', 'global', 'setTimeout',
          'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
          'clearImmediate', 'clear_context', '__toolFunctions',
          '__callMCPTool', '__workingDirectory', 'navigator', 'window'
        ]);

        for (const key in global) {
          if (!systemProps.has(key) && key !== 'persistentContext') {
            try {
              persistentContext[key] = global[key];
            } catch (e) {
              // Skip properties that can't be serialized
            }
          }
        }

        // If the code returns a value, add it to output
        if (result !== undefined) {
          console.log(result);
        }

        const output = stopCapture();
        process.send({ type: 'EXEC_RESULT', execId, success: true, output });
      } catch (err) {
        const output = stopCapture();
        process.send({
          type: 'EXEC_RESULT',
          execId,
          success: false,
          error: `${output}\nError: ${err.message}\n${err.stack}`
        });
      }
    })();
  } else if (msg.type === 'INIT_TOOLS') {
    // Initialize MCP tool functions
    const { toolFunctions } = msg;

    // Store tool functions for re-initialization after clear_context
    global.__toolFunctions = toolFunctions;
    global.__callMCPTool = global.__callMCPTool; // Ensure this is preserved

    // Generate tool functions that call back to parent
    eval(toolFunctions);

    // Add clear_context function
    global.clear_context = () => {
      // Clear the persistent context
      for (const key of Object.keys(persistentContext)) {
        delete persistentContext[key];
      }

      // Preserve system functions and MCP infrastructure in global
      const preserve = new Set([
        '__filename', '__dirname', 'module', 'exports', 'require',
        'console', 'process', 'Buffer', 'global',
        'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        'setImmediate', 'clearImmediate',
        'clear_context', '__toolFunctions', '__callMCPTool', '__workingDirectory'
      ]);

      // Clear user variables from global
      for (const key of Object.keys(global)) {
        if (!preserve.has(key)) {
          delete global[key];
        }
      }

      // Re-initialize all MCP tool functions
      if (global.__toolFunctions) {
        eval(global.__toolFunctions);
        console.log('[Context cleared and tools re-initialized]');
      } else {
        console.log('[Context cleared]');
      }
    };

    // Log reminder about async tools
    originalConsoleLog('[Execution worker ready]');
    originalConsoleLog('[Example] const result = await Read("file.txt");');

    process.send({ type: 'INIT_COMPLETE' });
  }
});

// Helper function for MCP tool calls
global.__callMCPTool = async (serverName, toolName, args) => {
  const callId = nextCallId++;

  return new Promise((resolve, reject) => {
    pendingMCPCalls.set(callId, { resolve, reject });

    process.send({
      type: 'MCP_CALL',
      callId,
      serverName,
      toolName,
      args
    });

    // Timeout of 180 seconds for long-running operations
    setTimeout(() => {
      if (pendingMCPCalls.has(callId)) {
        pendingMCPCalls.delete(callId);
        reject(new Error('MCP call timeout'));
      }
    }, 180000);
  });
};

process.on('SIGINT', () => {
  originalConsoleLog('[Execution worker] Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  originalConsoleLog('[Execution worker] Received SIGTERM, shutting down...');
  process.exit(0);
});

originalConsoleLog('[Execution worker ready]');
