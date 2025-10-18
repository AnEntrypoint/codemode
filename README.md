# CodeMode Agent

A Claude agent with an execute tool that provides programmatic access to file operations, system commands, and MCP tools. Features interactive mode with real-time typing, persistent execution context, and seamless integration with multiple MCP servers.

## Features

- **Interactive Mode**: Real-time command input with Escape key to hide/show typing prompt
- **Execute Tool**: Run JavaScript code with persistent context across executions
- **Built-in Functions**: Read, Write, Edit, Glob, Grep, Bash, LS, WebFetch, WebSearch, TodoWrite
- **MCP Integration**: Glootie, Playwright, and Vexify tools available as functions
- **Persistent Context**: Variables persist across execute calls within the same session
- **Signal Handling**: Proper Ctrl-C support for graceful shutdown
- **Syntax Highlighting**: Colorized code blocks and formatted output
- **Extended Thinking**: 10,000 token thinking budget with real-time streaming

## Installation

```bash
npm install -g codemode-agent
```

Or use with npx (no installation required):

```bash
npx codemode-agent --agent "Your task here"
```

## Usage

CodeMode supports two modes: **Agent Mode** (interactive) and **MCP Server Mode**.

### Agent Mode (Interactive)

Run Claude agent with execute tool for autonomous task completion:

```bash
# Interactive mode (default)
codemode-agent --agent "Create a React component"

# Single execution mode (non-interactive)
codemode-agent --agent "Fix bugs" --no-interactive

# Using npx
npx codemode-agent --agent "Your task here"
```

#### Interactive Mode Features

- **Type anytime**: Start typing to show the input prompt automatically
- **Escape key**: Press Escape to hide the typing prompt
- **Ctrl-C**: Gracefully exit at any time
- **Streaming output**: Watch the agent think and work in real-time

### MCP Server Mode

Start the MCP server that provides the execute tool:

```bash
# Start MCP server
codemode-agent --mcp

# Using npx
npx codemode-agent --mcp

# Disable external MCP servers (built-in tools only)
codemode-agent --mcp --nomcp
```

Add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "codeMode": {
      "command": "npx",
      "args": ["codemode-agent", "--mcp"]
    }
  }
}
```

## Examples

### Basic File Operations

```bash
# Create a file
codemode-agent --agent "Create a file called test.txt with content 'Hello World'"

# Search code
codemode-agent --agent "Find all JavaScript files and count the lines of code"

# Edit files
codemode-agent --agent "Replace all console.log with logger.info in src/"
```

### Web Automation

```bash
# Navigate and extract data
codemode-agent --agent "Navigate to example.com and get the page title"

# Screenshot capture
codemode-agent --agent "Take a screenshot of github.com"

# Form automation
codemode-agent --agent "Fill out the contact form on example.com"
```

### Code Analysis

```bash
# Semantic search
codemode-agent --agent "Find all authentication-related functions"

# AST pattern matching
codemode-agent --agent "Find all useState calls with initial value of null"

# Codebase audit
codemode-agent --agent "List all TODO comments with their locations"
```

## Available Functions

### File Operations

- **Read(path, offset?, limit?)** - Read file content with optional line ranges
- **Write(path, content)** - Write or overwrite file content
- **Edit(path, oldString, newString, replaceAll?)** - Exact string replacement in files
- **Glob(pattern, path?, as_array?)** - Find files matching glob patterns (returns string by default, JSON array if as_array=true)

### Search Operations

- **Grep(pattern, path?, options?)** - Search for patterns using ripgrep
  - Options: `{glob, type, output_mode, '-i', '-n', '-A', '-B', '-C', multiline, head_limit}`

### System Operations

- **Bash(command, description?, timeout?)** - Execute shell commands
- **LS(path?, show_hidden?, recursive?, files_only?)** - List directory contents

### Web Operations

- **WebFetch(url, prompt)** - Fetch and analyze web content
- **WebSearch(query, allowed_domains?, blocked_domains?)** - Search the web

### Task Management

- **TodoWrite(todos)** - Write and manage todo lists
  - Format: `[{content, status, activeForm}]`
  - Status: `'pending' | 'in_progress' | 'completed'`

### MCP Tools

All MCP tools are available via namespaced functions. Use `serverName.toolName(params)` format.

#### Glootie (Code Execution & Analysis)

- **glootie.execute(code, runtime?, workingDirectory?, timeout?)** - Execute code in various runtimes
- **glootie.ast_tool(operation, workingDirectory, pattern, ...)** - AST pattern matching for code structure searches
- **glootie.caveat(workingDirectory, action, text?, id?)** - Manage technical caveats and limitations

#### Playwright (Browser Automation)

- **playwright.browser_navigate(url)** - Navigate to URL
- **playwright.browser_snapshot()** - Capture accessibility snapshot
- **playwright.browser_click(element, ref)** - Click on element
- **playwright.browser_type(element, ref, text, slowly?, submit?)** - Type text into element
- **playwright.browser_evaluate(function, element?, ref?)** - Execute JavaScript in browser
- **playwright.browser_take_screenshot(element?, ref?, filename?, type?, fullPage?)** - Take screenshot
- **playwright.browser_close()** - Close browser
- **playwright.browser_resize(width, height)** - Resize browser window
- **playwright.browser_console_messages(onlyErrors?)** - Get console messages
- **playwright.browser_handle_dialog(accept, promptText?)** - Handle dialogs
- **playwright.browser_file_upload(paths?)** - Upload files
- **playwright.browser_fill_form(fields)** - Fill multiple form fields
- **playwright.browser_press_key(key)** - Press keyboard key
- **playwright.browser_navigate_back()** - Navigate back
- **playwright.browser_network_requests()** - Get network requests
- **playwright.browser_hover(element, ref)** - Hover over element
- **playwright.browser_drag(startElement, startRef, endElement, endRef)** - Drag and drop
- **playwright.browser_select_option(element, ref, values)** - Select dropdown option
- **playwright.browser_tabs(action, index?)** - Manage browser tabs
- **playwright.browser_wait_for(text?, textGone?, time?)** - Wait for conditions

#### Vexify (Semantic Code Search)

- **vexify.search_code(query, top_k?, include_content?)** - Semantic code search using embeddings

## Architecture

CodeMode consists of three main components:

### 1. cli.js - Unified Entry Point

Routes to agent mode or MCP server mode based on command-line flags.

### 2. agent.js - Interactive Claude Agent

- Streams responses with real-time thinking display
- Manages interactive input with Escape key support
- Handles signal interrupts (Ctrl-C)
- Formats output with syntax highlighting
- Integrates with MCP servers via execute tool

### 3. code-mode.js - MCP Server

- Exposes execute tool to Claude
- Manages persistent execution context
- Spawns and manages child MCP servers
- Handles graceful shutdown of all processes
- Injects tool functions into JavaScript runtime

### 4. execution-worker.js - Persistent Worker

- Maintains execution context across calls
- Handles IPC communication with parent
- Manages variable persistence
- Responds to shutdown signals

### 5. interactive-mode.js - Input Handler

- Manages readline interface
- Handles keyboard events (typing, Escape, Ctrl-C)
- Shows/hides input prompt dynamically
- Queues commands for agent execution

## Configuration

Create `.codemode.json` to configure MCP servers:

```json
{
  "mcpServers": {
    "builtInTools": {
      "command": "node",
      "args": ["built-in-tools-mcp.js"]
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

Configuration file is searched in order:
1. Current working directory: `./.codemode.json`
2. Library directory: `./node_modules/codemode-agent/.codemode.json`
3. User home directory: `~/.claude/.codemode.json`

## Persistent Execution Context

Variables persist across execute calls within the same session:

```javascript
// First execute call
myVar = 42;
console.log(myVar);

// Second execute call (same session)
console.log(myVar);
```

Variables declared with `let`, `const`, or `var` do NOT persist. Use bare assignment or `global.myVar` for persistence.

Use `clear_context()` to reset the execution context.

## Testing

Run the test suite:

```bash
npm test
```

For full integration testing:

```bash
# Start MCP server
node code-mode.js

# In another terminal
node test-builtin-tools.js
```

## Command-Line Flags

### Agent Mode

- `--agent [task]` - Run in agent mode with optional initial task
- `--no-interactive` - Run single execution without interactive mode

### MCP Server Mode

- `--mcp` - Start MCP server mode
- `--nomcp` - Disable external MCP servers (built-in tools only)

## Signal Handling

CodeMode properly handles interrupt signals:

- **Ctrl-C (SIGINT)**: Gracefully shuts down all processes
- **SIGTERM**: Clean shutdown of worker and MCP servers
- **Escape Key**: Hides typing prompt in interactive mode

All child processes (MCP servers, execution worker) receive proper shutdown signals and clean up resources.

## Keyboard Shortcuts

### Interactive Mode

- **Type**: Show input prompt automatically
- **Escape**: Hide input prompt and clear current line
- **Enter**: Submit command to agent
- **Ctrl-C**: Exit application

## Dependencies

- `@anthropic-ai/claude-agent-sdk` - Agent framework and streaming
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `chalk` - Terminal colors and styling
- `highlight.js` - Code syntax highlighting
- `fast-glob` - File pattern matching
- `chokidar` - File system watching
- `uuid` - Unique identifier generation
- `which` - Command resolution
- `zod` - Schema validation

## Troubleshooting

### Ctrl-C Not Working

If Ctrl-C doesn't interrupt execution, ensure you're running the latest version:

```bash
npm install -g codemode-agent@latest
```

### MCP Server Timeout

For long-running operations, the timeout is set to 180 seconds. If you need longer:

Edit `execution-worker.js` and increase the timeout value in `__callMCPTool`.

### Variable Not Persisting

Variables declared with `let`, `const`, or `var` don't persist. Use bare assignment:

```javascript
// Won't persist
let myVar = 42;

// Will persist
myVar = 42;

// Will persist
global.myVar = 42;
```

### Terminal Colors Not Showing

Ensure your terminal supports ANSI colors. For Windows, use Windows Terminal or WSL.

## Version

Current version: **2.0.38**

See [CHANGELOG.md](CHANGELOG.md) for full version history and recent changes.

## License

MIT

## Author

lanmower

## Contributing

Contributions welcome! Please open an issue or submit a pull request.

## Links

- [GitHub Repository](https://github.com/lanmower/codemode-agent)
- [npm Package](https://www.npmjs.com/package/codemode-agent)
- [MCP Documentation](https://modelcontextprotocol.io/)
