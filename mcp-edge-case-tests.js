// Additional Edge Case Tests for MCP Read/Write
import fs from 'fs';

const edgeCaseContent = `
// Test 1: Nested escape sequences
const nestedEscapes = \\\`
This contains \\\\\\\`triply escaped backticks\\\\\\\`
And \\\\\\\\\\\`quadruple escaped\\\\\\\\\\\`
Normal backtick: \\\`
\\\`;

// Test 2: Mixed quotes in templates
const mixedQuotes = \\\`
"Double quoted text"
'Single quoted text'
\\\`Backtick quoted text\\\`
Mixed: "test" and 'other' and \\\`third\\\`
\\\`;

// Test 3: Unicode characters with escapes
const unicodeEscapes = \\\`
Unicode backtick: \\\\u0060
Unicode dollar: \\\\u0024
Unicode quote: \\\\u0022
Unicode backslash: \\\\u005C
Actual: \\\` $ " \\\\
\\\`;

// Test 4: Binary data simulation
const binaryLike = \\\`
\x60\x24\x22\x5C
Null byte: \\\\x00
Newline: \\\\x0A
Tab: \\\\x09
\\\`;

// Test 5: Large template string
const largeTemplate = \\\`
\${Array(100).fill('This is line').map((line, i) => \\\`\${line} \${i} with \\\`backticks\\\` and \\\${i} expressions\\\`).join('\\\\n')}
\\\`;

// Test 6: Regex edge cases
const regexEdgeCases = [
  new RegExp('\\\\\\\\', 'g'), // double backslash
  new RegExp('\\\\\\`', 'g'), // escaped backtick
  new RegExp('\\\\\\$', 'g'), // escaped dollar
  new RegExp('\\\\u[0-9a-fA-F]{4}', 'g'), // unicode escape
  new RegExp('\\\\x[0-9a-fA-F]{2}', 'g'), // hex escape
];

// Test 7: JSON with backticks
const jsonWithBackticks = JSON.stringify({
  message: "This contains \\\`backticks\\\` in JSON",
  nested: {
    template: \\\`Template with \\\${variable} and \\\`backticks\\\`\\\`,
    regex: "/\\\`[^\\\`]*\\\`/g"
  }
});

// Test 8: Function parameter edge cases
const functionEdgeCases = {
  namedParams: function(param1 = \\\`default\\\`, param2 = \\\`value\\\`) {
    return param1 + param2;
  },

  destructuring: function({name = \\\`default\\\`, value = \\\`test\\\`}) {
    return {name, value};
  },

  restParams: function(...args) {
    return args.map(arg =\\\`default\\\` => arg || \\\`fallback\\\`);
  }
};

module.exports = {
  nestedEscapes,
  mixedQuotes,
  unicodeEscapes,
  binaryLike,
  largeTemplate,
  regexEdgeCases,
  jsonWithBackticks,
  functionEdgeCases
};
`;

console.log('Writing edge case test file...');
fs.writeFileSync('/mnt/c/dev/codemode/mcp-edge-case-content.js', edgeCaseContent);

console.log('Reading back edge case content...');
const readBackEdge = fs.readFileSync('/mnt/c/dev/codemode/mcp-edge-case-content.js', 'utf8');

console.log('=== Edge Case Test Results ===\n');

// Check for specific corruption patterns
const edgeCaseTests = [
  {
    name: 'Nested escape sequences',
    pattern: /\\\\\\\\\\\\\\`/g,
    description: 'Triple escaped backticks'
  },
  {
    name: 'Mixed quotes',
    pattern: /["'\\\`]/g,
    description: 'Quote characters'
  },
  {
    name: 'Unicode escapes',
    pattern: /\\\\u[0-9a-fA-F]{4}/g,
    description: 'Unicode escape sequences'
  },
  {
    name: 'Hex escapes',
    pattern: /\\\\x[0-9a-fA-F]{2}/g,
    description: 'Hex escape sequences'
  },
  {
    name: 'Regex patterns',
    pattern: /\/[^\/]*\\\\/g,
    description: 'Regex with backslashes'
  }
];

edgeCaseTests.forEach(test => {
  const originalMatches = edgeCaseContent.match(test.pattern) || [];
  const readBackMatches = readBackEdge.match(test.pattern) || [];

  console.log(\`\${test.name} (\${test.description}):\`);
  console.log(\`  Original: \${originalMatches.length} matches\`);
  console.log(\`  Read back: \${readBackMatches.length} matches\`);
  console.log(\`  Status: \${originalMatches.length === readBackMatches.length ? '✅' : '❌'}\`);

  if (originalMatches.length !== readBackMatches.length) {
    console.log(\`  First few original: \${originalMatches.slice(0, 3).join(', ')}\`);
    console.log(\`  First few read back: \${readBackMatches.slice(0, 3).join(', ')}\`);
  }
  console.log('');
});

// Character-level analysis
console.log('=== Character-level Analysis ===\n');

const originalBytes = Buffer.byteLength(edgeCaseContent, 'utf8');
const readBackBytes = Buffer.byteLength(readBackEdge, 'utf8');

console.log(\`Original byte length: \${originalBytes}\`);
console.log(\`Read back byte length: \${readBackBytes}\`);
console.log(\`Difference: \${Math.abs(originalBytes - readBackBytes)}\`);

if (originalBytes !== readBackBytes) {
  console.log('❌ Byte length mismatch detected');
} else {
  console.log('✅ Byte length matches');
}

// Find specific corrupted lines
const originalLines = edgeCaseContent.split('\\n');
const readBackLines = readBackEdge.split('\\n');

let corruptionCount = 0;
for (let i = 0; i < Math.max(originalLines.length, readBackLines.length); i++) {
  if (originalLines[i] !== readBackLines[i]) {
    corruptionCount++;
    if (corruptionCount <= 5) { // Show first 5 corrupted lines
      console.log(\`\\nCorruption at line \${i + 1}:\`);
      console.log(\`  Expected: \${JSON.stringify(originalLines[i])}\`);
      console.log(\`  Actual:   \${JSON.stringify(readBackLines[i])}\`);
    }
  }
}

console.log(\`\\nTotal corrupted lines: \${corruptionCount}\`);
console.log(\`Total lines: \${Math.max(originalLines.length, readBackLines.length)}\`);
console.log(\`Corruption rate: \${((corruptionCount / Math.max(originalLines.length, readBackLines.length)) * 100).toFixed(2)}%\`);