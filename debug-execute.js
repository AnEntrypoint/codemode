const { executeCode } = await import('./execute-handler.js');

// Test the executeCode function directly
try {
  const result = await executeCode({
    code: `
      console.log("Testing Write tool availability...");
      try {
        await Write('test-direct.txt', 'Hello from direct executeCode test!');
        console.log("✓ Write tool executed successfully");

        const content = await Read('test-direct.txt');
        console.log("✓ Read tool result:", content);
      } catch (error) {
        console.error("✗ Tool error:", error.message);
      }
    `
  });
  console.log('SUCCESS:', result);
} catch (error) {
  console.error('ERROR:', error.message);
  console.error('STACK:', error.stack);
}