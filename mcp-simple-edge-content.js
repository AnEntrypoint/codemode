
// Test 1: Basic escaped backticks
const basicEscaped = `This has \`escaped backticks\` in it`;

// Test 2: Multiple consecutive escapes
const consecutive = `Test \\\`triple\\\` escapes`;

// Test 3: Mixed escape sequences
const mixedEscapes = `Newline: \\n Tab: \\t Quote: \\" Backslash: \\\\ Backtick: \\\` Dollar: \\\$`;

// Test 4: Template expressions with escapes
const templateExpr = \`Value: \${value} with \`backticks\` and \\\`escapes\\\``;

// Test 5: JSON-like strings
const jsonString = `{"message": "Contains \`backticks\` and \\\`escapes\\\`"}`;

// Test 6: Function parameters (simplified)
const funcTest = `function(param = \`default\`) { return param; }`;

// Test 7: Regex-like strings
const regexString = `/\\\`[^\\\`]*\\\`/g`;

// Test 8: Complex nested structure
const complex = \`
Level 1: \`escaped\`
Level 2: \\\`double escaped\\\`
Level 3: \\\\\`triple escaped\\\\\`
Normal: `backtick`
Expression: \${variable}
\`;

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
