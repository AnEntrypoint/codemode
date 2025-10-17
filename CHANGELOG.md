# CodeMode Agent Changelog

## Version 2.0.19 - October 17, 2025

### Breaking Changes
- **Object-Based MCP Tool API**: All MCP tools now use object notation
  - Tools are organized by server name: `serverName.toolName(params)`
  - Examples: `builtInTools.Bash('ls')`, `playwright.browser_navigate('https://example.com')`
  - Removes all prefixes for cleaner, more intuitive API
  - **Migration**: Update `toolName()` calls to `serverName.toolName()`

### Architecture Changes
- **Simplified Tool Exposure**: Only `execute` tool is exposed to agents
  - All MCP tools available as functions within execute context
  - Dynamic tool description lists all available tools by server
  - Removed standalone `createWindow` tool (use `playwright.browser_navigate` directly)

### Improvements
- Enhanced execute tool description with dynamic MCP tool listing
- Added usage examples in tool description
- Improved tool organization and discoverability
- Better namespace management prevents naming conflicts

## Version 2.0.18 - October 17, 2025

### New Features
- **Added createWindow Tool**: New convenience tool for creating browser windows with Playwright
  - `mcp__codeMode__createWindow(url, width, height)`
  - Automatically resizes browser and navigates to specified URL
  - Simplifies common browser automation workflows
  - Integrates with existing Playwright MCP tools

### Implementation Details
- Tool added to code-mode.js MCP server
- Wraps `browser_resize` and `browser_navigate` Playwright tools
- Default dimensions: 1280x720 pixels
- Proper error handling and validation

## Version 2.0.17 - October 17, 2025

### Bug Fixes
- **Fixed "Bash is not defined" Error**: Resolved critical issue where built-in tools were not properly injected into execution context
- **MCP Server Configuration**: Fixed missing `builtInTools` MCP server configuration in test environments
- **Tool Injection**: Enhanced execution worker tool injection mechanism for proper tool availability
- **Dependency Resolution**: Improved module resolution and error handling for built-in tools

### Testing & Validation
- Added comprehensive test suite covering:
  - MCP server initialization and tool listing
  - Execution worker tool injection
  - Code-mode integration testing
  - Complete workflow validation
  - Edge case and error handling
- All core files pass syntax validation
- Verified Bash tool availability and functionality

## Latest Enhancements

### Comprehensive Colored Output
- Added `chalk` for terminal colors and styling
- Added `highlight.js` for syntax highlighting of code blocks
- Implemented comprehensive output formatting with sections, headers, and visual separators
- Color-coded different output types:
  - **Yellow**: Thinking blocks (💭)
  - **Green**: Responses and completions (✓)
  - **Blue**: Tool usage (🔧)
  - **Red**: Errors (✗)
  - **Gray**: Meta information and borders

### Extended Thinking Support
- Enabled Claude's extended thinking mode with 10,000 token budget
- Real-time streaming of thinking process with `thinking_delta` events
- Visual display of thinking blocks with borders and numbering
- Comprehensive event handling for all message types

### Dynamic Tool Descriptions
- Created `getBuiltInToolSchemas()` to define tool schemas programmatically
- Updated `generateMCPFunctions()` to collect and return tool descriptions
- Execute tool description now dynamically includes:
  - All built-in functions (Read, Write, Edit, Glob, Grep, Bash, LS, TodoWrite)
  - All MCP tools organized by server (glootie, playwright, vexify)
  - Complete parameter lists and descriptions for each tool

### Configuration Management
- Added `--nomcp` flag support to disable MCP tools
- Updated config loading to check directories in priority order:
  1. Current working directory (`./.codemode.json`)
  2. Library directory (`/path/to/codemode/.codemode.json`)
  3. User home directory (`~/.claude/.codemode.json`)
- Comprehensive logging of config loading process

### Code Formatting
- Line-numbered code blocks with syntax highlighting
- Support for multiple programming languages
- Color-coded tokens:
  - Keywords (magenta)
  - Strings (green)
  - Numbers (yellow)
  - Comments (gray)
  - Functions (blue/cyan)
  - Operators (white)

### Event Handling
- Comprehensive streaming event processing:
  - `text`: Regular text messages
  - `thinking_delta`/`thinking`: Thinking blocks with real-time streaming
  - `assistant`: Assistant responses with content blocks
  - `tool_result`: Tool execution results with previews
  - `error`: Error messages with stack traces
- Real-time progress updates during agent execution

### Error Handling
- Enhanced error display with colored output
- Stack trace inclusion for debugging
- Clear error messages with visual separators

## Features

### Built-in Functions (Dynamically Documented)
- **Read(file_path, offset?, limit?)**: Read file content with line numbers
- **Write(file_path, content)**: Write/overwrite files with directory creation
- **Edit(file_path, old_string, new_string, replace_all?)**: Exact string replacement
- **Glob(pattern, path?)**: File pattern matching
- **Grep(pattern, path?, options?)**: Ripgrep-powered content search
- **Bash(command, description?, timeout?)**: Shell command execution
- **LS(path?, show_hidden?, recursive?)**: Directory listing
- **TodoWrite(todos)**: Task tracking and progress display

### MCP Integration (Dynamically Documented)
- **glootie**: Code execution, AST analysis, caveat management
- **playwright**: 20+ browser automation tools
- **vexify**: Semantic code search

## Usage

```bash
# Basic usage
npx codemode-agent --agent "Your task here"

# Disable MCP tools
npx codemode-agent --agent "Your task here" --nomcp

# MCP server mode
npx codemode-agent --mcp
```

## Technical Details

### Dependencies
- `@anthropic-ai/claude-agent-sdk`: Agent framework
- `@modelcontextprotocol/sdk`: MCP protocol support
- `chalk`: Terminal colors (v5.3.0+)
- `highlight.js`: Syntax highlighting
- `fast-glob`: File pattern matching
- `chokidar`: File watching
- `uuid`: Unique identifiers
- `which`: Command resolution
- `zod`: Schema validation

### Architecture
1. **cli.js**: Entry point routing to agent or MCP mode
2. **agent.js**: Claude agent with streaming, thinking, and colored output
3. **code-mode.js**: MCP server exposing execute tool with dynamic function injection

### Configuration
`.codemode.json` structure:
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

## Implementation Notes

### Thinking Mode
Extended thinking is enabled with a 10,000 token budget, allowing Claude to show its reasoning process in real-time. This provides visibility into the agent's decision-making and problem-solving approach.

### Dynamic Tool Descriptions
Tool descriptions are generated at runtime by:
1. Querying each MCP server for its tools
2. Extracting tool schemas from built-in function definitions
3. Formatting descriptions with parameter lists and documentation
4. Combining into comprehensive execute tool description

This ensures tool documentation stays in sync with implementation and allows for easy extension with new tools.

### Color Scheme
The color scheme is designed for readability on both light and dark terminals:
- Bold colors for headers and important information
- Gray for borders and meta information
- Semantic colors (green for success, red for errors, yellow for warnings)
- Syntax highlighting follows standard conventions

## Version History

### 1.0.13 (Current)
- Added comprehensive colored output with chalk and highlight.js
- Enabled extended thinking mode with real-time streaming
- Implemented dynamic tool descriptions
- Enhanced configuration management with --nomcp flag
- Improved event handling and error display
- Updated documentation and examples
