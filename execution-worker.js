#!/usr/bin/env node

// Persistent execution context worker
// Communicates with parent via IPC for MCP tool calls

const pendingMCPCalls = new Map();
let nextCallId = 0;

// Capture console output
let capturedOutput = '';
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function startCapture() {
  capturedOutput = '';

  console.log = (...args) => {
    const msg = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    capturedOutput += msg + '\n';
    originalConsoleLog(...args);
  };

  console.error = (...args) => {
    const msg = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    capturedOutput += msg + '\n';
    originalConsoleError(...args);
  };

  console.warn = (...args) => {
    const msg = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    capturedOutput += msg + '\n';
    originalConsoleWarn(...args);
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
      startCapture();
      try {
        process.chdir(workingDirectory);
        const result = await eval(`(async () => { ${code} })()`);

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

    // Generate tool functions that call back to parent
    eval(toolFunctions);

    // Add clear_context function
    global.clear_context = () => {
      const preserve = new Set([
        '__filename', '__dirname', 'module', 'exports', 'require',
        'console', 'process', 'Buffer', 'global',
        'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        'setImmediate', 'clearImmediate',
        'clear_context', ...Object.keys(global).filter(k => k.startsWith('browser_') || k.startsWith('mcp_') || k.startsWith('search_'))
      ]);

      for (const key of Object.keys(global)) {
        if (!preserve.has(key)) {
          delete global[key];
        }
      }

      console.log('[Context cleared]');
    };

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

    setTimeout(() => {
      if (pendingMCPCalls.has(callId)) {
        pendingMCPCalls.delete(callId);
        reject(new Error('MCP call timeout'));
      }
    }, 60000);
  });
};

originalConsoleLog('[Execution worker ready]');
