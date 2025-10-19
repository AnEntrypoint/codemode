// MCP Read/Write Test File - Complex Template Strings and Content
// This file tests various edge cases for content corruption

const complexTemplate = `
This is a complex template literal with multiple backticks \`inside\` the string.
It also contains ${Math.random()} dynamic expressions.
Here's a JSON string: '{"key": "value", "nested": {"array": [1, 2, 3]}}'
And another backtick: \`another one\`
`;

const jsonString = `{
  "name": "Test User",
  "age": 25,
  "active": true,
  "profile": {
    "bio": "This is a user bio with 'single quotes' and \"double quotes\"",
    "settings": {
      "theme": "dark",
      "notifications": false,
      "regex": "/^test.*$/gi"
    }
  },
  "tags": ["javascript", "testing", \`template literals\`]
}`;

const multiLineString = `
    This is a multi-line string
    with various indentation levels
        - Nested item 1
        - Nested item 2
    Back to normal indentation
    Contains escape sequences: \\n \\t \\r \\\\ \\"
    And special characters: @#$%^&*()_+-=[]{}|;':",./<>?
`;

const regexPatterns = [
  /^test.*$/gi,
  /https?:\/\/[^\s]+/g,
  /\`[^`]*\`/g, // matches backtick content
  /\$\{[^}]*\}/g // matches template expressions
];

const complexFunction = function(\`param1\`, param2 = \`default\`) {
  const templateString = \`Hello \${param1}, your value is \${param2}\`;
  return {
    original: templateString,
    escaped: \`Escaped backtick: \\\` and escaped dollar: \\\$\`,
    combined: \`This contains both \`backticks\` and \${param2} expressions\`
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
    return \`
Generated content at: \${new Date().toISOString()}
Random value: \${Math.random()}
JSON in template: \${JSON.stringify({test: true, value: 42})}
Backticks in JSON: {"message": "This has \`backticks\` inside"}
    \`.trim();
  }
};