#!/usr/bin/env node

const args = process.argv.slice(2);
const hasMcpFlag = args.includes('--mcp');
const hasAgentFlag = args.includes('--agent');

if (hasMcpFlag && hasAgentFlag) {
  console.error('Error: Cannot use both --mcp and --agent flags');
  console.error('');
  console.error('Usage:');
  console.error('  codemode-agent --mcp              Start MCP server mode');
  console.error('  codemode-agent --agent [task]     Start agent mode');
  process.exit(1);
}

if (hasMcpFlag) {
  import('./code-mode.js');
} else if (hasAgentFlag) {
  import('./agent.js');
} else {
  console.error('Usage:');
  console.error('  codemode-agent --mcp                      Start MCP server mode');
  console.error('  codemode-agent --agent [task]             Start agent mode (interactive by default)');
  console.error('  codemode-agent --agent [task] --no-interactive   Single execution mode');
  console.error('');
  console.error('Examples:');
  console.error('  codemode-agent --mcp');
  console.error('  codemode-agent --agent "Create a file called test.txt"');
  console.error('  codemode-agent --agent "Fix bugs" --no-interactive');
  console.error('');
  console.error('Install globally or use with npx:');
  console.error('  npx codemode-agent --mcp');
  console.error('  npx codemode-agent --agent "Your task"');
  process.exit(1);
}
