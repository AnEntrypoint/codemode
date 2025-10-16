# Claude Tools Replica MCP Server

A comprehensive MCP (Model Context Protocol) server that replicates all of Claude's internal tools with 100% behavioral compatibility.

## 🚀 Features

### File System Tools
- **Read** - Read files with offset/limit support
- **Write** - Write files with automatic directory creation
- **Edit** - Exact string replacement with optional global replace
- **Glob** - Fast file pattern matching using find
- **Grep** - Powerful search using ripgrep with all flags

### Bash Execution Tools
- **Bash** - Execute commands with timeout and background support
- **BashOutput** - Retrieve output from background shells
- **KillShell** - Kill background shells by ID
- **Background Shell Management** - Up to 8 persistent shells

### Web Tools (using curl)
- **WebFetch** - Fetch and process web content
- **WebSearch** - Search the web with domain filtering

### Task Management Tools
- **Task** - Execute complex tasks using sandboxbox
- **TodoWrite** - Create and manage structured task lists
- **SlashCommand** - Execute slash commands
- **ExitPlanMode** - Present plans for approval

## 📦 Installation

```bash
npm install
```

## 🔧 Usage

### As MCP Server

1. **For Claude Desktop:**

   Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "claude-tools-replica": {
         "command": "node",
         "args": ["/path/to/this/index.js"],
         "cwd": "/path/to/this"
       }
     }
   }
   ```

2. **For other MCP clients:**

   ```bash
   node index.js
   ```

### Direct Usage

```bash
# Start the server
npm start

# Run tests
npm test

# Development mode with file watching
npm run dev
```

## 🛠️ Architecture

- **ES Modules** - Modern JavaScript with import/export
- **Background Shell Management** - Persistent shells with unique IDs
- **Curl-based Web Tools** - No external dependencies for web operations
- **Sandboxbox Integration** - Leverages sandboxbox for complex tasks
- **Error Handling** - Comprehensive error handling with proper error responses

## 📋 Tool Specifications

### File System Tools

#### Read
```json
{
  "name": "Read",
  "description": "Reads a file from the local filesystem",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "The absolute path to the file to read" },
      "offset": { "type": "number", "description": "The line number to start reading from" },
      "limit": { "type": "number", "description": "The number of lines to read" }
    },
    "required": ["file_path"]
  }
}
```

#### Write
```json
{
  "name": "Write",
  "description": "Writes a file to the local filesystem",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "The absolute path to the file to write" },
      "content": { "type": "string", "description": "The content to write to the file" }
    },
    "required": ["file_path", "content"]
  }
}
```

#### Edit
```json
{
  "name": "Edit",
  "description": "Performs exact string replacements in files",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "The absolute path to the file to modify" },
      "old_string": { "type": "string", "description": "The text to replace" },
      "new_string": { "type": "string", "description": "The text to replace it with" },
      "replace_all": { "type": "boolean", "description": "Replace all occurrences", "default": false }
    },
    "required": ["file_path", "old_string", "new_string"]
  }
}
```

#### Glob
```json
{
  "name": "Glob",
  "description": "Fast file pattern matching tool that works with any codebase size",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "The glob pattern to match files against" },
      "path": { "type": "string", "description": "The directory to search in" }
    },
    "required": ["pattern"]
  }
}
```

#### Grep
```json
{
  "name": "Grep",
  "description": "A powerful search tool built on ripgrep",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "The regular expression pattern to search for" },
      "path": { "type": "string", "description": "File or directory to search in" },
      "glob": { "type": "string", "description": "Glob pattern to filter files" },
      "output_mode": { "type": "string", "enum": ["content", "files_with_matches", "count"], "default": "files_with_matches" },
      "-B": { "type": "number", "description": "Number of lines to show before each match" },
      "-A": { "type": "number", "description": "Number of lines to show after each match" },
      "-C": { "type": "number", "description": "Number of lines to show before and after each match" },
      "-n": { "type": "boolean", "description": "Show line numbers in output" },
      "-i": { "type": "boolean", "description": "Case insensitive search" },
      "type": { "type": "string", "description": "File type to search" },
      "head_limit": { "type": "number", "description": "Limit output to first N lines/entries" },
      "multiline": { "type": "boolean", "description": "Enable multiline mode" }
    },
    "required": ["pattern"]
  }
}
```

### Bash Tools

#### Bash
```json
{
  "name": "Bash",
  "description": "Executes a given bash command in a persistent shell session with optional timeout",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "The command to execute" },
      "timeout": { "type": "number", "description": "Optional timeout in milliseconds (up to 600000ms)" },
      "description": { "type": "string", "description": "Clear, concise description of what this command does" },
      "run_in_background": { "type": "boolean", "description": "Run the command in the background" }
    },
    "required": ["command"]
  }
}
```

#### BashOutput
```json
{
  "name": "BashOutput",
  "description": "Retrieves output from a running or completed background bash shell",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bash_id": { "type": "string", "description": "The shell ID to retrieve output from" },
      "filter": { "type": "string", "description": "Optional regex filter for output lines" }
    },
    "required": ["bash_id"]
  }
}
```

#### KillShell
```json
{
  "name": "KillShell",
  "description": "Kills a running background bash shell by its ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "shell_id": { "type": "string", "description": "The shell ID to kill" }
    },
    "required": ["shell_id"]
  }
}
```

### Web Tools

#### WebFetch
```json
{
  "name": "WebFetch",
  "description": "Fetches content from a specified URL and processes it using an AI model",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "format": "uri", "description": "The URL to fetch content from" },
      "prompt": { "type": "string", "description": "The prompt to run on the fetched content" }
    },
    "required": ["url", "prompt"]
  }
}
```

#### WebSearch
```json
{
  "name": "WebSearch",
  "description": "Allows Claude to search the web and use the results to inform responses",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "minLength": 2, "description": "The search query to use" },
      "allowed_domains": { "type": "array", "items": {"type": "string"}, "description": "Only include search results from these domains" },
      "blocked_domains": { "type": "array", "items": {"type": "string"}, "description": "Never include search results from these domains" }
    },
    "required": ["query"]
  }
}
```

### Task Management Tools

#### Task
```json
{
  "name": "Task",
  "description": "Execute complex tasks using sandboxbox environment",
  "inputSchema": {
    "type": "object",
    "properties": {
      "description": { "type": "string", "description": "Short (3-5 word) description of the task" },
      "prompt": { "type": "string", "description": "The task for the agent to perform" },
      "subagent_type": { "type": "string", "description": "The type of specialized agent to use", "enum": ["general-purpose", "researcher", "coder", "analyst", "optimizer", "coordinator"] }
    },
    "required": ["description", "prompt", "subagent_type"]
  }
}
```

#### TodoWrite
```json
{
  "name": "TodoWrite",
  "description": "Create and manage a structured task list for current coding session",
  "inputSchema": {
    "type": "object",
    "properties": {
      "todos": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "content": { "type": "string", "minLength": 1 },
            "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] },
            "activeForm": { "type": "string", "minLength": 1 }
          },
          "required": ["content", "status", "activeForm"]
        },
        "description": "The updated todo list"
      }
    },
    "required": ["todos"]
  }
}
```

#### SlashCommand
```json
{
  "name": "SlashCommand",
  "description": "Execute a slash command within the main conversation",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "The slash command to execute, including any arguments" }
    },
    "required": ["command"]
  }
}
```

#### ExitPlanMode
```json
{
  "name": "ExitPlanMode",
  "description": "Exit plan mode and present the plan for approval",
  "inputSchema": {
    "type": "object",
    "properties": {
      "plan": { "type": "string", "description": "The plan that was created" }
    },
    "required": ["plan"]
  }
}
```

## 🔍 Testing

Run the test suite:

```bash
npm test
```

## 🤝 Compatibility

This MCP server is designed to be 100% compatible with Claude's internal tools. It replicates:

- ✅ Input/output specifications
- ✅ Parameter validation
- ✅ Error handling
- ✅ Corner case behavior
- ✅ Background shell management
- ✅ All tool signatures

## 📝 License

MIT

## 🚀 Contributing

Contributions welcome! Please ensure all tools maintain 100% behavioral compatibility with Claude's internal tools.