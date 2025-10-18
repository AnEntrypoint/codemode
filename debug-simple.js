const { executeCode } = await import('./execute-handler.js');

try {
  console.log('Testing builtInTools directly...');

  const result = await executeCode({
    workingDirectory: '/mnt/c/dev/codemode',
    code: `
      console.log("Testing builtInTools.Write directly...");
      await builtInTools.Write('direct-test.txt', 'Direct test!');
      console.log("✓ Direct builtInTools.Write worked");

      const content = await builtInTools.Read('direct-test.txt');
      console.log("✓ File content:", content);
    `
  });

  console.log('Success:', result);
} catch (error) {
  console.error('Error:', error.message);
}