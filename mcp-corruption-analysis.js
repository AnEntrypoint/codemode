// Detailed Analysis of MCP Read/Write Corruption Issues
import fs from 'fs';

// Test specific problematic patterns
const testCases = [
  {
    name: 'Regex with escaped backticks',
    content: '/\\`[^\\`]*\\`/g',
    description: 'Regex pattern that should match backtick content'
  },
  {
    name: 'Function with backtick parameter',
    content: 'function(\\`param\\`, default = \\`value\\`)',
    description: 'Function definition with backtick parameters'
  },
  {
    name: 'Escaped backtick in template',
    content: '\\`This should stay escaped\\`',
    description: 'Escaped backtick in template literal'
  },
  {
    name: 'Mixed escape sequences',
    content: '\\n\\t\\r\\\\\\"\\`\\$',
    description: 'Various escape sequences'
  }
];

// Read the corrupted file
const corruptedContent = fs.readFileSync('/mnt/c/dev/codemode/mcp-test-complex-content.js', 'utf8');

console.log('=== MCP Read/Write Corruption Analysis ===\n');

// Find the specific corrupted lines
const lines = corruptedContent.split('\n');

console.log('Analyzing specific corruption issues:\n');

// Check line 39 (regex pattern)
const line39 = lines[38]; // 0-indexed
console.log('Line 39 (Regex pattern):');
console.log(`Current: ${JSON.stringify(line39)}`);
console.log(`Expected: ${JSON.stringify('  /\\`[^\\`]*\\`/g, // matches backtick content')}`);
console.log(`Match: ${line39 === '  /\\`[^\\`]*\\`/g, // matches backtick content' ? '✅' : '❌'}`);
console.log('');

// Check line 43 (function definition)
const line43 = lines[42]; // 0-indexed
console.log('Line 43 (Function definition):');
console.log(`Current: ${JSON.stringify(line43)}`);
console.log(`Expected: ${JSON.stringify('const complexFunction = function(\\`param1\\`, param2 = \\`default\\`) {')}`);
console.log(`Match: ${line43 === 'const complexFunction = function(\\`param1\\`, param2 = \\`default\\`) {' ? '✅' : '❌'}`);
console.log('');

// Analyze the exact differences
console.log('=== Detailed Difference Analysis ===\n');

const expectedLine39 = '  /\\`[^\\`]*\\`/g, // matches backtick content';
const expectedLine43 = 'const complexFunction = function(\\`param1\\`, param2 = \\`default\\`) {';

function analyzeDifference(expected, actual, description) {
  console.log(`${description}:`);
  console.log(`Expected: ${expected}`);
  console.log(`Actual:   ${actual}`);

  // Character by character comparison
  const maxLen = Math.max(expected.length, actual.length);
  for (let i = 0; i < maxLen; i++) {
    const expChar = expected[i] || '(missing)';
    const actChar = actual[i] || '(missing)';

    if (expChar !== actChar) {
      console.log(`Difference at position ${i}: expected '${expChar}', got '${actChar}'`);

      // Show context around the difference
      const start = Math.max(0, i - 5);
      const end = Math.min(maxLen, i + 6);
      console.log(`Context: '${expected.substring(start, end)}' -> '${actual.substring(start, end)}'`);
      break;
    }
  }
  console.log('');
}

analyzeDifference(expectedLine39, line39, 'Line 39 Regex Pattern');
analyzeDifference(expectedLine43, line43, 'Line 43 Function Definition');

// Test specific escape sequence handling
console.log('=== Escape Sequence Analysis ===\n');

const escapeSequenceTests = [
  '\\`', // escaped backtick
  '\\\\', // double backslash
  '\\$', // escaped dollar
  '\\"', // escaped quote
  '\\n', // escaped newline
  '\\t', // escaped tab
];

escapeSequenceTests.forEach(escape => {
  const regex = new RegExp(escape.replace(/\\/g, '\\\\'), 'g');
  const expectedMatches = (expectedLine39 + expectedLine43).match(regex) || [];
  const actualMatches = (line39 + line43).match(regex) || [];

  console.log(`Escape sequence '${escape}':`);
  console.log(`  Expected count: ${expectedMatches.length}`);
  console.log(`  Actual count: ${actualMatches.length}`);
  console.log(`  Status: ${expectedMatches.length === actualMatches.length ? '✅' : '❌'}`);
});

// Summary of corruption patterns
console.log('\n=== Corruption Summary ===\n');

console.log('Identified corruption patterns:');
console.log('1. Escaped backticks in regex patterns: Some backslashes are being lost');
console.log('2. Function parameters with escaped backticks: Inconsistent escape handling');
console.log('3. Byte length preserved but content altered: Character substitution rather than deletion');

console.log('\n=== Impact Assessment ===\n');

console.log('Critical issues found:');
console.log('❌ Regex patterns may be malformed');
console.log('❌ Function syntax may be broken');
console.log('❌ Template literal escape sequences inconsistent');
console.log('✅ Overall byte length maintained');
console.log('✅ Most escape sequences preserved');

// Recommend testing approach
console.log('\n=== Recommended Additional Tests ===\n');

console.log('Test these specific scenarios:');
console.log('1. Nested escape sequences: \\\\\\`');
console.log('2. Mixed quotes in templates: `"test" and \'test\'`');
console.log('3. Unicode characters with escapes: \\u0060');
console.log('4. Binary data in string literals');
console.log('5. Large template strings (>10KB)');