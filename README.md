# CodeMode Agent

A Claude agent with an execute tool that provides programmatic access to file operations, system commands, and MCP tools.

## Features

- **Execute Tool**: Run JavaScript code with built-in functions
- **Built-in Functions**: Read, Write, Edit, Glob, Grep, Bash, LS, WebFetch, WebSearch, TodoWrite, Task
- **MCP Integration**: Glootie, Playwright, and Vexify tools available as functions
- **Programmatic API**: No need for linear tool-by-tool execution

## Installation

```bash
npm install
```

## Usage

The tool supports two modes: **Agent Mode** and **MCP Server Mode**.

### Agent Mode

Run Claude agent with execute tool for autonomous task completion:

```bash
# Using npm
npm start -- "Your task here"

# Using Node directly
node cli.js --agent "Your task here"

# Via npx (recommended)
npx codemode-agent --agent "Your task here"
```

### MCP Server Mode

Start the MCP server that provides the execute tool:

```bash
# Using Node directly
node cli.js --mcp

# Via npx (recommended)
npx codemode-agent --mcp
```

### Quick Reference

```bash
# Agent mode examples
npx codemode-agent --agent "Create a file called test.txt"
npx codemode-agent --agent "Navigate to example.com and get the title"

# MCP server mode (for use with Claude Desktop or other MCP clients)
npx codemode-agent --mcp
```

## Examples

### Create a file

```bash
npx codemode-agent --agent "Create a file called test.txt with content 'Hello World'"
```

### Web automation

```bash
npx codemode-agent --agent "Navigate to https://example.com and get the page title"
```

### File analysis

```bash
npx codemode-agent --agent "Find all JavaScript files and count the lines of code"
```

## Available Functions

### File Operations
- `Read(path, offset?, limit?)` - Read file content
- `Write(path, content)` - Write content to file
- `Edit(path, oldString, newString, replaceAll?)` - Edit file
- `Glob(pattern, path?)` - Find files matching pattern

### Search Operations
- `Grep(pattern, path?, options?)` - Search for pattern in files

### System Operations
- `Bash(command, description?, timeout?)` - Execute shell command
- `LS(path?, show_hidden?, recursive?)` - List directory contents

### Web Operations
- `WebFetch(url, prompt)` - Fetch and analyze web content
- `WebSearch(query, allowed_domains?, blocked_domains?)` - Search the web

### Task Management
- `TodoWrite(todos)` - Write todo list

### Glootie MCP
- `execute(code, runtime?, workingDirectory?, timeout?)` - Execute code
- `ast_tool(operation, workingDirectory, pattern, ...)` - AST pattern matching
- `caveat(workingDirectory, action, text?, id?)` - Manage caveats

### Playwright MCP
- `browser_navigate(url)` - Navigate to URL
- `browser_snapshot()` - Capture page snapshot
- `browser_click(element, ref)` - Click element
- `browser_type(element, ref, text)` - Type text
- `browser_evaluate(_function)` - Execute JavaScript
- `browser_take_screenshot(...)` - Take screenshot
- `browser_close()` - Close browser
- And 15+ more browser automation tools

### Vexify MCP
- `search_code(query, topK?, includeContent?)` - Semantic code search

## Architecture

1. **cli.js** - Unified CLI entry point that routes to agent or MCP mode
2. **agent.js** - Claude agent that uses the execute tool via MCP
3. **code-mode.js** - MCP server that exposes the execute tool

The execute tool dynamically generates JavaScript function wrappers for all configured MCP tools and injects them into the execution environment.

## Configuration

Edit `.codemode.json` to configure MCP servers:

```json
{
  "mcpServers": {
    "glootie": {
      "command": "npx",
      "args": ["-y", "mcp-glootie@latest"]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "vexify": {
      "command": "npx",
      "args": ["-y", "vexify@latest", "mcp"]
    }
  }
}
```

## License

MIT
