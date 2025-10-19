// Content Integrity Test for MCP Read/Write Tools
import fs from 'fs';

// Original content that was written to the file
const originalContent = `// MCP Read/Write Test File - Complex Template Strings and Content
// This file tests various edge cases for content corruption

const complexTemplate = \`
This is a complex template literal with multiple backticks \\\`inside\\\` the string.
It also contains \${Math.random()} dynamic expressions.
Here's a JSON string: '{"key": "value", "nested": {"array": [1, 2, 3]}}'
And another backtick: \\\`another one\\\`
\`;

const jsonString = \`{
  "name": "Test User",
  "age": 25,
  "active": true,
  "profile": {
    "bio": "This is a user bio with 'single quotes' and \\"double quotes\\"",
    "settings": {
      "theme": "dark",
      "notifications": false,
      "regex": "/^test.*$/gi"
    }
  },
  "tags": ["javascript", "testing", \\\`template literals\\\`]
}\`;

const multiLineString = \`
    This is a multi-line string
    with various indentation levels
        - Nested item 1
        - Nested item 2
    Back to normal indentation
    Contains escape sequences: \\\\n \\\\t \\\\r \\\\\\\\ \\\\"
    And special characters: @#$%^&*()_+-=[]{}|;':",./<>?
\`;

const regexPatterns = [
  /^test.*$/gi,
  /https?:\\/\\/[^\\s]+/g,
  /\\\`[^\\\`]*\\\`/g, // matches backtick content
  /\\\$\\{[^}]*\\}/g // matches template expressions
];

const complexFunction = function(\\\`param1\\\`, param2 = \\\`default\\\) {
  const templateString = \\\`Hello \\\${param1}, your value is \\\${param2}\\\`;
  return {
    original: templateString,
    escaped: \\\`Escaped backtick: \\\\\\\` and escaped dollar: \\\\\\\$\\\`,
    combined: \\\`This contains both \\\`backticks\\\` and \\\${param2} expressions\\\`
  };
};

// Export everything for testing
module.exports = {
  complexTemplate,
  jsonString,
  multiLineString,
  regexPatterns,
  complexFunction,

  // Test method that generates dynamic content
  generateTestContent: function() {
    return \\\`
Generated content at: \\\${new Date().toISOString()}
Random value: \\\${Math.random()}
JSON in template: \\\${JSON.stringify({test: true, value: 42})}
Backticks in JSON: {"message": "This has \\\`backticks\\\` inside"}
    \\\`.trim();
  }
};`;

// Read the file content back
const readBackContent = fs.readFileSync('/mnt/c/dev/codemode/mcp-test-complex-content.js', 'utf8');

// Comparison function
function compareContent(original, readBack) {
  const originalLines = original.split('\n');
  const readBackLines = readBack.split('\n');

  console.log(`Original lines: ${originalLines.length}`);
  console.log(`Read back lines: ${readBackLines.length}`);
  console.log('---');

  let differences = [];
  let maxLines = Math.max(originalLines.length, readBackLines.length);

  for (let i = 0; i < maxLines; i++) {
    const originalLine = originalLines[i] || '';
    const readBackLine = readBackLines[i] || '';

    if (originalLine !== readBackLine) {
      differences.push({
        lineNumber: i + 1,
        original: originalLine,
        readBack: readBackLine
      });
    }
  }

  if (differences.length === 0) {
    console.log('✅ NO CORRUPTION DETECTED - Content matches perfectly!');
  } else {
    console.log('❌ CORRUPTION DETECTED - Differences found:');
    console.log('---');
    differences.forEach(diff => {
      console.log(`Line ${diff.lineNumber}:`);
      console.log(`  Original: ${JSON.stringify(diff.original)}`);
      console.log(`  ReadBack: ${JSON.stringify(diff.readBack)}`);
      console.log('');
    });
  }

  // Character-level analysis
  const originalBytes = Buffer.byteLength(original, 'utf8');
  const readBackBytes = Buffer.byteLength(readBack, 'utf8');

  console.log(`Original byte length: ${originalBytes}`);
  console.log(`Read back byte length: ${readBackBytes}`);
  console.log(`Byte length difference: ${Math.abs(originalBytes - readBackBytes)}`);

  return {
    lineDifferences: differences,
    byteLengthDifference: Math.abs(originalBytes - readBackBytes),
    integrity: differences.length === 0 && originalBytes === readBackBytes
  };
}

// Run the comparison
const result = compareContent(originalContent, readBackContent);

// Test specific patterns that are prone to corruption
const testPatterns = [
  /`[^`]*`/g, // backtick literals
  /\${[^}]*}/g, // template expressions
  /\\[ntr"\\`$]/g, // escape sequences
  /\[[^\]]*\]/g, // arrays
  /\{[^}]*\}/g // objects
];

console.log('\n--- Pattern Analysis ---');
testPatterns.forEach((pattern, index) => {
  const originalMatches = originalContent.match(pattern) || [];
  const readBackMatches = readBackContent.match(pattern) || [];

  console.log(`Pattern ${index + 1}: ${pattern}`);
  console.log(`  Original matches: ${originalMatches.length}`);
  console.log(`  Read back matches: ${readBackMatches.length}`);
  console.log(`  Match: ${originalMatches.length === readBackMatches.length ? '✅' : '❌'}`);

  if (originalMatches.length !== readBackMatches.length) {
    console.log(`  Original: ${originalMatches.slice(0, 3).join(', ')}${originalMatches.length > 3 ? '...' : ''}`);
    console.log(`  ReadBack: ${readBackMatches.slice(0, 3).join(', ')}${readBackMatches.length > 3 ? '...' : ''}`);
  }
});

console.log('\n--- Test Summary ---');
console.log(`Overall integrity: ${result.integrity ? '✅ PASSED' : '❌ FAILED'}`);
console.log(`Total line differences: ${result.lineDifferences.length}`);
console.log(`Byte length difference: ${result.byteLengthDifference}`);