// Simple Edge Case Tests for MCP Read/Write
import fs from 'fs';

const simpleEdgeContent = `
// Test 1: Basic escaped backticks
const basicEscaped = \`This has \\\`escaped backticks\\\` in it\`;

// Test 2: Multiple consecutive escapes
const consecutive = \`Test \\\\\\\`triple\\\\\\\` escapes\`;

// Test 3: Mixed escape sequences
const mixedEscapes = \`Newline: \\\\n Tab: \\\\t Quote: \\\\" Backslash: \\\\\\\\ Backtick: \\\\\\\` Dollar: \\\\\\\$\`;

// Test 4: Template expressions with escapes
const templateExpr = \\\`Value: \\\${value} with \\\`backticks\\\` and \\\\\\\`escapes\\\\\\\`\`;

// Test 5: JSON-like strings
const jsonString = \`{"message": "Contains \\\`backticks\\\` and \\\\\\\`escapes\\\\\\\`"}\`;

// Test 6: Function parameters (simplified)
const funcTest = \`function(param = \\\`default\\\`) { return param; }\`;

// Test 7: Regex-like strings
const regexString = \`/\\\\\\\`[^\\\\\\\`]*\\\\\\\`/g\`;

// Test 8: Complex nested structure
const complex = \\\`
Level 1: \\\`escaped\\\`
Level 2: \\\\\\\`double escaped\\\\\\\`
Level 3: \\\\\\\\\\\`triple escaped\\\\\\\\\\\`
Normal: \`backtick\`
Expression: \\\${variable}
\\\`;

module.exports = {
  basicEscaped,
  consecutive,
  mixedEscapes,
  templateExpr,
  jsonString,
  funcTest,
  regexString,
  complex
};
`;

console.log('Writing simple edge case test file...');
fs.writeFileSync('/mnt/c/dev/codemode/mcp-simple-edge-content.js', simpleEdgeContent);

console.log('Reading back simple edge case content...');
const readBackSimple = fs.readFileSync('/mnt/c/dev/codemode/mcp-simple-edge-content.js', 'utf8');

console.log('=== Simple Edge Case Test Results ===\n');

// Test specific patterns
const patterns = [
  { name: 'Escaped backticks', pattern: /\\\\\\`/g, expected: 8 },
  { name: 'Double escaped backticks', pattern: /\\\\\\\\\\`/g, expected: 4 },
  { name: 'Triple escaped backticks', pattern: /\\\\\\\\\\\\\\`/g, expected: 2 },
  { name: 'Escaped dollars', pattern: /\\\\\\$/g, expected: 1 },
  { name: 'Template expressions', pattern: /\\$\\{[^}]*\\}/g, expected: 2 },
  { name: 'Normal backticks', pattern: /(?<!\\\\)`/g, expected: 12 }
];

patterns.forEach(({name, pattern, expected}) => {
  const matches = readBackSimple.match(pattern) || [];
  console.log(`${name}:`);
  console.log(`  Expected: ${expected} matches`);
  console.log(`  Found: ${matches.length} matches`);
  console.log(`  Status: ${matches.length === expected ? '✅' : '❌'}`);
  if (matches.length > 0) {
    console.log(`  Examples: ${matches.slice(0, 3).join(', ')}`);
  }
  console.log('');
});

// Line by line comparison
const originalLines = simpleEdgeContent.split('\\n');
const readBackLines = readBackSimple.split('\\n');

let corruptedLines = 0;
const corruptionDetails = [];

for (let i = 0; i < Math.max(originalLines.length, readBackLines.length); i++) {
  if (originalLines[i] !== readBackLines[i]) {
    corruptedLines++;
    if (corruptionDetails.length < 5) {
      corruptionDetails.push({
        line: i + 1,
        expected: originalLines[i],
        actual: readBackLines[i]
      });
    }
  }
}

console.log('=== Corruption Summary ===\n');
console.log(`Total lines: ${Math.max(originalLines.length, readBackLines.length)}`);
console.log(`Corrupted lines: ${corruptedLines}`);
console.log(`Corruption rate: ${((corruptedLines / Math.max(originalLines.length, readBackLines.length)) * 100).toFixed(2)}%`);

if (corruptionDetails.length > 0) {
  console.log('\\nFirst few corrupted lines:');
  corruptionDetails.forEach(({line, expected, actual}) => {
    console.log(`Line ${line}:`);
    console.log(`  Expected: ${JSON.stringify(expected)}`);
    console.log(`  Actual:   ${JSON.stringify(actual)}`);
    console.log('');
  });
}

// Test content integrity
const originalBytes = Buffer.byteLength(simpleEdgeContent, 'utf8');
const readBackBytes = Buffer.byteLength(readBackSimple, 'utf8');

console.log('=== Byte-level Analysis ===\n');
console.log(`Original bytes: ${originalBytes}`);
console.log(`Read back bytes: ${readBackBytes}`);
console.log(`Difference: ${Math.abs(originalBytes - readBackBytes)}`);
console.log(`Integrity: ${originalBytes === readBackBytes ? '✅' : '❌'}`);

// Specific backslash analysis
console.log('\\n=== Backslash Analysis ===\n');
const originalBackslashes = (simpleEdgeContent.match(/\\\\/g) || []).length;
const readBackBackslashes = (readBackSimple.match(/\\\\/g) || []).length;

console.log(`Original backslashes: ${originalBackslashes}`);
console.log(`Read back backslashes: ${readBackBackslashes}`);
console.log(`Backslash loss: ${originalBackslashes - readBackBackslashes}`);

console.log('\\n=== Test Complete ===');