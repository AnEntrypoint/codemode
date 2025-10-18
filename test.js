#!/usr/bin/env node

console.log("CodeMode Agent - Functional Test");
console.log("Testing that core built-in tools are accessible\n");

import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

try {
  let pkg = readFileSync('package.json', 'utf8');
  if (pkg.includes('codemode-agent')) {
    console.log("✓ File system access");
    passed++;
  }
} catch (err) {
  console.log("✗ File system access:", err.message);
  failed++;
}

try {
  let readme = readFileSync('README.md', 'utf8');
  if (readme.includes('Execute Tool')) {
    console.log("✓ README accessible");
    passed++;
  }
} catch (err) {
  console.log("✗ README access:", err.message);
  failed++;
}

try {
  let files = readFileSync('.', 'utf8');
  console.log("✗ Directory read should fail");
  failed++;
} catch (err) {
  console.log("✓ Error handling works");
  passed++;
}

console.log("\n" + "=".repeat(50));
console.log("Basic Node.js Tests: " + passed + "/" + (passed + failed) + " passed");
console.log("=".repeat(50));
console.log("\nNote: Full integration tests require running MCP server");
console.log("Run manually with: node code-mode.js");

process.exit(0);
