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
const runningExecutions = new Map(); // Track running executions
const asyncExecutions = new Map(); // Track async executions after handover
const asyncHandoverTimeout = 30000; // 30 seconds default

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

    // Store in execution history for async handover
    const execution = runningExecutions.get(execId) || asyncExecutions.get(execId);
    if (execution) {
      execution.outputHistory.push({
        timestamp: Date.now(),
        type: 'log',
        message: msg
      });
    }

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

    // Store in execution history for async handover
    const execution = runningExecutions.get(execId) || asyncExecutions.get(execId);
    if (execution) {
      execution.outputHistory.push({
        timestamp: Date.now(),
        type: 'error',
        message: msg
      });
    }

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

    // Store in execution history for async handover
    const execution = runningExecutions.get(execId) || asyncExecutions.get(execId);
    if (execution) {
      execution.outputHistory.push({
        timestamp: Date.now(),
        type: 'warn',
        message: msg
      });
    }

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

function moveToAsyncMode(execId) {
  const execution = runningExecutions.get(execId);
  if (!execution) return;

  // Clear the handover timer
  if (execution.handoverTimer) {
    clearTimeout(execution.handoverTimer);
    execution.handoverTimer = null;
  }

  // Mark as async
  execution.isAsync = true;
  execution.asyncStartTime = Date.now();

  // Get current progress from output history
  const currentOutput = execution.outputHistory.map(entry =>
    `[${new Date(entry.timestamp).toISOString()}] ${entry.message}`
  ).join('\n');

  // Clear output history to save memory (as requested)
  execution.outputHistory = [];

  // Move to async executions
  runningExecutions.delete(execId);
  asyncExecutions.set(execId, execution);

  // Notify parent about handover with current progress
  process.send({
    type: 'ASYNC_HANDOVER',
    execId,
    executionInfo: {
      id: execId,
      code: execution.code,
      workingDirectory: execution.workingDirectory,
      startTime: execution.startTime,
      asyncStartTime: execution.asyncStartTime,
      currentOutput: currentOutput,
      isAsync: true
    }
  });

  console.log(`[Async Handover] Execution ${execId} moved to async mode, history cleared`);
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
  } else if (msg.type === 'KILL_EXECUTION') {
    // Kill a running or async execution
    const { execId } = msg;
    let killed = false;
    let error = null;

    if (execId) {
      // Kill specific execution
      if (runningExecutions.has(execId)) {
        const execution = runningExecutions.get(execId);
        execution.killed = true;
        if (execution.handoverTimer) {
          clearTimeout(execution.handoverTimer);
        }
        runningExecutions.delete(execId);
        killed = true;
      } else if (asyncExecutions.has(execId)) {
        const execution = asyncExecutions.get(execId);
        execution.killed = true;
        asyncExecutions.delete(execId);
        killed = true;
      } else {
        error = 'Execution not found';
      }
    } else {
      // Kill all executions
      let count = 0;
      runningExecutions.forEach((execution, id) => {
        execution.killed = true;
        if (execution.handoverTimer) {
          clearTimeout(execution.handoverTimer);
        }
        runningExecutions.delete(id);
        count++;
      });
      asyncExecutions.forEach((execution, id) => {
        execution.killed = true;
        asyncExecutions.delete(id);
        count++;
      });
      killed = true;
    }

    process.send({ type: 'EXECUTION_KILLED', execId, success: killed, error, killedCount: execId ? null : Array.from(runningExecutions.keys()).length + Array.from(asyncExecutions.keys()).length });
  } else if (msg.type === 'GET_ASYNC_EXECUTION') {
    // Get async execution details
    const { execId } = msg;
    if (asyncExecutions.has(execId)) {
      const execution = asyncExecutions.get(execId);
      process.send({
        type: 'ASYNC_EXECUTION_DATA',
        execId,
        data: {
          id: execId,
          code: execution.code,
          workingDirectory: execution.workingDirectory,
          startTime: execution.startTime,
          asyncStartTime: execution.asyncStartTime,
          outputHistory: execution.outputHistory,
          isKilled: execution.killed
        }
      });
    } else {
      process.send({
        type: 'ASYNC_EXECUTION_DATA',
        execId,
        error: 'Async execution not found'
      });
    }
  } else if (msg.type === 'LIST_ASYNC_EXECUTIONS') {
    // List all async executions
    const asyncList = Array.from(asyncExecutions.entries()).map(([id, execution]) => ({
      id,
      workingDirectory: execution.workingDirectory,
      startTime: execution.startTime,
      asyncStartTime: execution.asyncStartTime,
      outputHistoryLength: execution.outputHistory.length,
      isKilled: execution.killed
    }));
    process.send({ type: 'ASYNC_EXECUTIONS_LIST', executions: asyncList });
  } else if (msg.type === 'GET_SERVER_STATE') {
    // Return server state information
    const state = {
      runningExecutions: Array.from(runningExecutions.entries()).map(([id, info]) => ({
        id,
        startTime: info.startTime,
        code: info.code.substring(0, 100), // Truncate for security
        workingDirectory: info.workingDirectory,
        duration: Date.now() - info.startTime,
        isAsync: info.isAsync
      })),
      asyncExecutions: Array.from(asyncExecutions.entries()).map(([id, info]) => ({
        id,
        startTime: info.startTime,
        asyncStartTime: info.asyncStartTime,
        code: info.code.substring(0, 100), // Truncate for security
        workingDirectory: info.workingDirectory,
        duration: Date.now() - info.startTime,
        outputHistoryLength: info.outputHistory.length,
        isKilled: info.killed
      })),
      persistentContextSize: Object.keys(persistentContext).length,
      serverPersistent: true, // The server persists across executions
      asyncHandoverTimeout: asyncHandoverTimeout
    };
    process.send({ type: 'SERVER_STATE', state });
  } else if (msg.type === 'CLEAR_ASYNC_HISTORY') {
    // Clear output history for async execution
    const { execId, clearHistory } = msg;
    if (asyncExecutions.has(execId)) {
      const execution = asyncExecutions.get(execId);
      if (clearHistory) {
        execution.outputHistory = [];
      }
      process.send({
        type: 'ASYNC_HISTORY_CLEARED',
        execId,
        cleared: clearHistory,
        historyLength: execution.outputHistory.length
      });
    } else {
      process.send({
        type: 'ASYNC_HISTORY_CLEARED',
        execId,
        error: 'Async execution not found'
      });
    }
  } else if (msg.type === 'GET_ASYNC_PROGRESS') {
    // Get progress for async execution since a specific time
    const { execId, since } = msg;
    if (asyncExecutions.has(execId)) {
      const execution = asyncExecutions.get(execId);
      let outputHistory = execution.outputHistory;

      // Filter by timestamp if 'since' is provided
      if (since) {
        const sinceTime = new Date(since).getTime();
        outputHistory = outputHistory.filter(entry => entry.timestamp > sinceTime);
      }

      const progressOutput = outputHistory.map(entry =>
        `[${new Date(entry.timestamp).toISOString()}] ${entry.message}`
      ).join('\n');

      process.send({
        type: 'ASYNC_PROGRESS_DATA',
        execId,
        progress: progressOutput,
        totalEntries: outputHistory.length,
        executionDuration: Date.now() - execution.startTime
      });
    } else {
      process.send({
        type: 'ASYNC_PROGRESS_DATA',
        execId,
        error: 'Async execution not found'
      });
    }
  } else if (msg.type === 'EXECUTE') {
    const { execId, code, workingDirectory } = msg;

    (async () => {
      startCapture(execId);

      // Track this execution with timeout detection
      const executionInfo = {
        id: execId,
        code: code,
        workingDirectory: workingDirectory,
        startTime: Date.now(),
        killed: false,
        handoverTimer: null,
        isAsync: false,
        outputHistory: []
      };
      runningExecutions.set(execId, executionInfo);

      // Set up async handover timer
      executionInfo.handoverTimer = setTimeout(() => {
        if (runningExecutions.has(execId) && !executionInfo.killed) {
          // Move to async mode
          moveToAsyncMode(execId);
        }
      }, asyncHandoverTimeout);

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

        // Clean up execution tracking
        runningExecutions.delete(execId);

        process.send({ type: 'EXEC_RESULT', execId, success: true, output });
      } catch (err) {
        const output = stopCapture();

        // Clean up execution tracking
        runningExecutions.delete(execId);

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

    // Add clear_context function - now explicit, not automatic
    global.clear_context = () => {
      // Kill all running executions first
      for (const [execId, execution] of runningExecutions.entries()) {
        execution.killed = true;
        if (execution.handoverTimer) {
          clearTimeout(execution.handoverTimer);
        }
      }
      runningExecutions.clear();

      // Kill all async executions
      for (const [execId, execution] of asyncExecutions.entries()) {
        execution.killed = true;
      }
      asyncExecutions.clear();

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
        'clear_context', '__toolFunctions', '__callMCPTool', '__workingDirectory',
        'kill_execution', 'get_server_state', 'get_async_execution', 'list_async_executions'
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

    // Add execution management functions
    global.kill_execution = async (execId) => {
      if (execId) {
        // Kill specific execution
        process.send({ type: 'KILL_EXECUTION', execId });
        return new Promise((resolve) => {
          const listener = (msg) => {
            if (msg.type === 'EXECUTION_KILLED' && msg.execId === execId) {
              process.removeListener('message', listener);
              resolve({ success: msg.success, error: msg.error });
            }
          };
          process.on('message', listener);
        });
      } else {
        // Kill all executions
        return global.clear_context();
      }
    };

    global.get_server_state = async () => {
      process.send({ type: 'GET_SERVER_STATE' });
      return new Promise((resolve) => {
        const listener = (msg) => {
          if (msg.type === 'SERVER_STATE') {
            process.removeListener('message', listener);
            resolve(msg.state);
          }
        };
        process.on('message', listener);
      });
    };

    // Add async execution management functions
    global.get_async_execution = async (execId) => {
      process.send({ type: 'GET_ASYNC_EXECUTION', execId });
      return new Promise((resolve) => {
        const listener = (msg) => {
          if (msg.type === 'ASYNC_EXECUTION_DATA' && msg.execId === execId) {
            process.removeListener('message', listener);
            if (msg.error) {
              resolve({ error: msg.error });
            } else {
              resolve(msg.data);
            }
          }
        };
        process.on('message', listener);
      });
    };

    global.list_async_executions = async () => {
      process.send({ type: 'LIST_ASYNC_EXECUTIONS' });
      return new Promise((resolve) => {
        const listener = (msg) => {
          if (msg.type === 'ASYNC_EXECUTIONS_LIST') {
            process.removeListener('message', listener);
            resolve(msg.executions);
          }
        };
        process.on('message', listener);
      });
    };

    // Log reminder about async tools and server persistence
    originalConsoleLog('[Execution worker ready]');
    originalConsoleLog('[Example] const result = await Read("file.txt");');
    originalConsoleLog('[Server State] This server persists across all executions');
    originalConsoleLog('[Management] Use get_server_state() to check server status');
    originalConsoleLog('[Management] Use kill_execution(id) to kill running executions');
    originalConsoleLog('[Management] Use clear_context() to reset everything');

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
