# System Tool Analysis Documentation

## Overview
This document provides comprehensive analysis of all available tools in this Claude Code environment, including their input/output specifications, parameters, behaviors, and corner cases.

## Table of Contents
- [Built-in Claude Code Tools](#built-in-claude-code-tools)
- [MCP (Model Context Protocol) Tools](#mcp-model-context-protocol-tools)
- [Tool Usage Patterns and Best Practices](#tool-usage-patterns-and-best-practices)

## Built-in Claude Code Tools

### 1. Task Tool
**Purpose**: Launch specialized agents for complex, multi-step tasks

**Parameters**:
- `description` (string, required): Short (3-5 word) description of the task
- `prompt` (string, required): Detailed task description for the agent
- `subagent_type` (string, required): Type of specialized agent

**Available Subagent Types**:
- `general-purpose`: Complex questions, searching code, multi-step tasks (Tools: *)
- `statusline-setup`: Configure Claude Code status line setting (Tools: Read, Edit)
- `output-style-setup`: Create Claude Code output style (Tools: Read, Write, Edit, Glob, Grep)
- `Explore`: Fast codebase exploration (Tools: Glob, Grep, Read, Bash)

**Behavior**:
- Creates stateless agent that runs autonomously
- Returns single message with results upon completion
- Cannot send additional messages to the agent after invocation

**Corner Cases**:
- Use Explore agent for open-ended searches instead of direct search tools
- Don't use for specific file paths (use Read/Glob instead)
- Don't use for searching within specific files (use Read instead)

### 2. Bash Tool
**Purpose**: Execute shell commands in a persistent environment

**Parameters**:
- `command` (string, required): Shell command to execute
- `description` (string, optional): Clear, concise description (5-10 words, active voice)
- `timeout` (number, optional): Timeout in milliseconds (max 600000ms, default 120000ms)
- `run_in_background` (boolean, optional): Run command in background (default false)

**Behavior**:
- Executes in persistent shell session
- Captures stdout and stderr
- Supports proper command chaining with && and ;
- Maintains working directory state between calls

**Important Restrictions**:
- DO NOT use for file operations (reading, writing, editing, searching)
- Use dedicated tools instead: Read (not cat), Edit (not sed), Write (not echo), Glob/Grep (not find/grep)
- Quote file paths with spaces using double quotes

**Git Operations Protocol**:
- Only create commits when explicitly requested
- Never update git config or run destructive commands unless asked
- Use specific commit message format with Claude attribution

### 3. Glob Tool
**Purpose**: Fast file pattern matching

**Parameters**:
- `pattern` (string, required): Glob pattern (e.g., "**/*.js", "src/**/*.ts")
- `path` (string, optional): Directory to search (default: current working directory)

**Behavior**:
- Returns matching file paths sorted by modification time
- Supports standard glob syntax patterns
- More efficient than find/ls commands

**Corner Cases**:
- Omit path parameter for default directory behavior
- Don't pass "undefined" or "null" for path parameter

### 4. Grep Tool
**Purpose**: Powerful content search using ripgrep

**Parameters**:
- `pattern` (string, required): Regular expression pattern
- `path` (string, optional): File/directory to search (default: current working directory)
- `glob` (string, optional): File filter pattern (e.g., "*.js", "**/*.tsx")
- `type` (string, optional): File type (e.g., "js", "py", "rust")
- `output_mode` (string, optional): "content" (default), "files_with_matches", "count"
- `-A`, `-B`, `-C` (number, optional): Context lines after/before/around matches
- `-n` (boolean, optional): Show line numbers (requires output_mode: "content")
- `-i` (boolean, optional): Case insensitive search
- `head_limit` (number, optional): Limit output results
- `multiline` (boolean, optional): Enable multiline matching (default false)

**Behavior**:
- Uses ripgrep engine for fast pattern matching
- Supports full regex syntax
- Literal braces need escaping (e.g., "interface\\{\\}" for "interface{}")

**Corner Cases**:
- Default matching is within single lines only
- Use multiline: true for cross-line patterns
- Context parameters only work with output_mode: "content"

### 5. Read Tool
**Purpose**: Read file contents from filesystem

**Parameters**:
- `file_path` (string, required): Absolute path to file
- `offset` (number, optional): Line number to start reading
- `limit` (number, optional): Number of lines to read

**Behavior**:
- Reads up to 2000 lines by default from beginning
- Returns cat -n format with line numbers starting at 1
- Lines longer than 2000 characters are truncated
- Supports reading images, PDFs, and Jupyter notebooks

**Supported Formats**:
- Text files: Standard content display
- Images: Visual content presentation
- PDFs: Page-by-page text and visual extraction
- Jupyter notebooks: All cells with outputs

**Corner Cases**:
- Returns error reminder for empty files
- File path must be absolute, not relative
- Can read files that don't exist (returns error)

### 6. Edit Tool
**Purpose**: Perform exact string replacements in files

**Parameters**:
- `file_path` (string, required): Absolute path to file
- `old_string` (string, required): Text to replace
- `new_string` (string, required): Replacement text (must be different)
- `replace_all` (boolean, optional): Replace all occurrences (default false)

**Behavior**:
- Requires reading file first with Read tool
- Performs exact string matching (not regex)
- Preserves exact indentation from Read output
- Fails if old_string is not unique unless replace_all is true

**Corner Cases**:
- Line number prefixes from Read output must be excluded from string matching
- Use larger context strings for uniqueness
- Never use for creating new files

### 7. Write Tool
**Purpose**: Write or overwrite files

**Parameters**:
- `file_path` (string, required): Absolute path to file
- `content` (string, required): File content

**Behavior**:
- Overwrites existing files completely
- For existing files, must read with Read tool first
- Should prefer editing existing files over creating new ones

**Important Restrictions**:
- Never proactively create documentation files (*.md, README)
- Only create when explicitly required by user
- Never use emojis unless explicitly requested

### 8. NotebookEdit Tool
**Purpose**: Edit Jupyter notebook cells

**Parameters**:
- `notebook_path` (string, required): Absolute path to .ipynb file
- `cell_id` (string, required): ID of cell to edit
- `new_source` (string, required): New cell content
- `cell_type` (string, optional): "code" or "markdown" (default: current cell type)
- `edit_mode` (string, optional): "replace" (default), "insert", "delete"

**Behavior**:
- cell_id is 0-indexed for positioning
- Insert mode adds cell after specified cell_id
- Delete mode removes cell at specified cell_id

### 9. WebFetch Tool
**Purpose**: Retrieve and analyze web content

**Parameters**:
- `url` (string, required): Valid URL to fetch
- `prompt` (string, required): Analysis prompt for the content

**Behavior**:
- Fetches URL content and converts HTML to markdown
- Processes content with AI model using prompt
- Returns model's analysis of the content
- Includes 15-minute cache for repeated requests

**Corner Cases**:
- HTTP URLs automatically upgraded to HTTPS
- Returns redirect information when host changes
- Must make new request with redirect URL for redirected content

### 10. WebSearch Tool
**Purpose**: Search the web for current information

**Parameters**:
- `query` (string, required): Search query (min 2 characters)
- `allowed_domains` (array, optional): Only include results from these domains
- `blocked_domains` (array, optional): Exclude results from these domains

**Behavior**:
- Provides up-to-date information beyond knowledge cutoff
- Returns formatted search result blocks
- Only available in the US
- Domain filtering supported

### 11. TodoWrite Tool
**Purpose**: Create and manage structured task lists

**Parameters**:
- `todos` (array, required): Array of todo objects with:
  - `content` (string): Task description (imperative form)
  - `status` (string): "pending", "in_progress", "completed"
  - `activeForm` (string): Present continuous form

**Behavior**:
- Tracks progress for complex multi-step tasks
- Provides visibility into session progress
- Should be used proactively for complex tasks

**Usage Guidelines**:
- Use for tasks requiring 3+ distinct steps
- Use for non-trivial, complex tasks
- Mark tasks in_progress immediately before starting
- Mark tasks completed immediately after finishing
- Only one task should be in_progress at any time

### 12. BashOutput Tool
**Purpose**: Retrieve output from background bash processes

**Parameters**:
- `bash_id` (string, required): ID of background shell
- `filter` (string, optional): Regex filter for output lines

**Behavior**:
- Returns new output since last check
- Includes stdout, stderr, and shell status
- Supports optional regex filtering
- Shell IDs available via /bashes command

### 13. KillShell Tool
**Purpose**: Terminate background bash processes

**Parameters**:
- `shell_id` (string, required): ID of background shell to kill

**Behavior**:
- Terminates running background shell
- Returns success/failure status
- Shell IDs available via /bashes command

### 14. SlashCommand Tool
**Purpose**: Execute custom slash commands

**Parameters**:
- `command` (string, required): Slash command with arguments

**Behavior**:
- Expands to command prompt from .claude/commands/
- Shows <command-message>{name} is running… during execution
- Only use for commands listed in Available Commands

**Important Restrictions**:
- Don't use for built-in CLI commands
- Don't use for commands not shown in list
- Don't invoke if already running (check for command-message)

### 15. ExitPlanMode Tool
**Purpose**: Exit planning mode and present implementation plan

**Parameters**:
- `plan` (string, required): Implementation plan (markdown format)

**Behavior**:
- Prompts user to exit plan mode
- Only use for tasks requiring code implementation planning
- Don't use for research/analysis tasks

## MCP (Model Context Protocol) Tools

### glootie Tools

#### mcp__glootie__execute
**Purpose**: Execute glootie operations for code execution and analysis

**Environment Variables**:
- `MCP_CONNECT_TIMEOUT`: Connection timeout (2000ms)
- `MCP_TIMEOUT`: General timeout (3000ms)

**Parameters**: Specific parameters depend on glootie operation type

**Behavior**: Executes code operations through the glootie MCP server

#### mcp__glootie__ast_tool
**Purpose**: AST (Abstract Syntax Tree) operations for code parsing and manipulation

**Parameters**: AST-specific parameters for code analysis

**Behavior**: Provides AST parsing and manipulation capabilities

#### mcp__glootie__caveat
**Purpose**: Handle code caveats, warnings, and best practice checks

**Parameters**: Code analysis parameters for caveat detection

**Behavior**: Analyzes code for potential issues and improvements

### playwright Tools

#### mcp__playwright__browser_navigate
**Purpose**: Navigate browser to specified URL

**Parameters**:
- `url` (string): Target URL to navigate to

**Behavior**: Opens browser and navigates to specified URL

#### mcp__playwright__browser_snapshot
**Purpose**: Capture current browser state snapshot

**Parameters**:
- Optional screenshot parameters
- Optional DOM state parameters

**Behavior**: Takes snapshot of current browser state/content

#### mcp__playwright__browser_click
**Purpose**: Click on DOM elements in browser

**Parameters**:
- `selector` (string): CSS selector or XPath for element
- Optional click options (button, modifiers, etc.)

**Behavior**: Simulates mouse click on specified element

#### mcp__playwright__browser_type
**Purpose**: Type text into browser input fields

**Parameters**:
- `selector` (string): Target element selector
- `text` (string): Text to type
- Optional typing options (delay, etc.)

**Behavior**: Simulates keyboard text input

#### mcp__playwright__browser_evaluate
**Purpose**: Execute JavaScript in browser context

**Parameters**:
- `script` (string): JavaScript code to execute
- Optional arguments for script

**Behavior**: Runs JavaScript code and returns results

#### mcp__playwright__browser_close
**Purpose**: Close browser session

**Parameters**: Optional cleanup parameters

**Behavior**: Terminates browser session and cleans up resources

### vexify Tools

#### mcp__vexify__search_code
**Purpose**: Advanced code search with vexify engine

**Parameters**:
- `query` (string): Search query pattern
- Optional scope parameters (file types, directories)
- Optional search options

**Behavior**: Performs sophisticated code search and analysis

## Tool Usage Patterns and Best Practices

### Parallel Execution
- Use multiple tool calls in single response when operations are independent
- Maximum efficiency through parallel processing
- Sequential calls only when operations depend on each other

### File Operations Hierarchy
1. **Prefer editing existing files** over creating new ones
2. **Use dedicated tools** over bash commands:
   - Read instead of cat/head/tail
   - Edit instead of sed/awk
   - Write instead of echo/heredoc
   - Glob/Grep instead of find/grep
   - Bash for system commands only

### Error Handling
- Always read files before editing them
- Check git status before committing changes
- Use proper command chaining (&&) for dependent operations
- Handle timeouts and background processes appropriately

### Security Considerations
- Only assist with defensive security tasks
- Refuse malicious code creation/improvement
- Allow security analysis, detection rules, vulnerability explanations
- No credential discovery or harvesting assistance

### Performance Optimization
- Use Task agents for complex searches instead of direct tool calls
- Leverage caching mechanisms (WebFetch 15-minute cache)
- Use background processes for long-running operations
- Choose appropriate output modes to limit result sizes

### Communication Patterns
- Output all communication directly in response text
- Never use bash comments or code for user communication
- Use tools only for task completion, not communication
- Maintain professional, objective technical tone

---

*This documentation provides comprehensive analysis of all available tools. For specific MCP tool details, consult individual tool documentation as available.*


## Testing

### Test Infrastructure
- test.js: Basic functional tests using Node.js fs module
- npm test: Runs test.js
- Integration tests (test-*.js files) require MCP server running

### Testing Patterns
- Built-in tools return strings, not objects/arrays
- Glob returns newline-separated string of files
- Grep returns working directory path as string
- Execute tool requires MCP protocol communication
- Worker process exits after execution, needs proper result handling

### Test Execution
- Simple tests: npm test (synchronous, no MCP required)
- Integration tests: node code-mode.js (start server first)
- Execute tool tests: Use MCP protocol with tools/call method
