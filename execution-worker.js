#!/usr/bin/env node

// Persistent execution context worker
// Communicates with parent via IPC for MCP tool calls

const pendingMCPCalls = new Map();
let nextCallId = 0;

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
      try {
        process.chdir(workingDirectory);
        await eval(`(async () => { ${code} })()`);
        process.send({ type: 'EXEC_RESULT', execId, success: true, output: '' });
      } catch (err) {
        process.send({ type: 'EXEC_RESULT', execId, success: false, error: err.message });
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
        'clear_context', ...Object.keys(global).filter(k => k.startsWith('browser_') || k.startsWith('mcp_'))
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

console.log('[Execution worker ready]');
