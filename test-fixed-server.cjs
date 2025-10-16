const { spawn } = require('child_process');

const proc = spawn('node', ['code-mode.js'], { stdio: ['pipe', 'pipe', 'inherit'] });

let responded = false;
const startTime = Date.now();

proc.stdout.on('data', (data) => {
  try {
    const response = JSON.parse(data.toString());
    if (!responded && response.result && response.result.description) {
      responded = true;
      const duration = Date.now() - startTime;
      console.log('✅ Response received in', duration, 'ms');

      const desc = response.result.description;
      const hasDirectNames = desc.includes('**Read**:') && desc.includes('**Write**:');
      const hasPrefixedNames = desc.includes('**filesystem_Read**:');

      console.log('✅ Prefixes removed:', hasDirectNames && !hasPrefixedNames);
      console.log('✅ Contains MCP functions:', desc.includes('Available functions'));

      const match = desc.match(/Available functions \((\d+) total\)/);
      console.log('✅ Function count:', match ? match[1] : 'unknown');

      proc.kill();
      process.exit(0);
    }
  } catch (e) {
    // ignore parse errors
  }
});

proc.on('close', () => {
  if (!responded) {
    console.log('❌ Server closed without responding');
    process.exit(1);
  }
});

// Send tools list request
setTimeout(() => {
  console.log('Sending tools/list request...');
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  }) + '\n');
}, 1000);

setTimeout(() => {
  if (!responded) {
    console.log('❌ Timeout - no response received');
    proc.kill();
    process.exit(1);
  }
}, 8000);