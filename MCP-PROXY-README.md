# Simple MCP Proxy

A minimal Model Context Protocol (MCP) proxy that aggregates tools from multiple MCP servers and presents them as a single unified interface.

## What It Does

The MCP proxy allows you to:
- Connect to multiple external MCP servers
- Aggregate all their tools into a single interface
- Forward tool calls to the appropriate server
- Add prefixes to tool names to avoid conflicts

## Files

- **`simple-mcp-proxy.js`** - The main proxy server
- **`index.js`** - File system MCP server (13 tools: Read, Write, Edit, Glob, Grep, Bash, etc.)
- **`code-mode.js`** - Code execution MCP server (4 tools: execute, execute_output, execute_list, execute_kill)
- **`mcp-config.json`** - Configuration file (for future use)
- **`test-simple-proxy.js`** - Test script to verify proxy functionality

## Usage

### Start the Proxy
```bash
node simple-mcp-proxy.js
```

### Test the Proxy
```bash
node test-simple-proxy.js
```

### Configure Claude to Use the Proxy
Add this to your Claude configuration:
```json
{
  "mcpServers": {
    "proxy": {
      "command": "node",
      "args": ["/path/to/mcp-proxy.js"]
    }
  }
}
```

## Available Tools (17 total)

### File System Tools (prefixed with `filesystem_`)
1. `filesystem_Read` - Read files from the local filesystem
2. `filesystem_Write` - Write/overwrite files
3. `filesystem_Edit` - Perform exact string replacements in files
4. `filesystem_Glob` - Fast file pattern matching
5. `filesystem_Grep` - Powerful search using ripgrep
6. `filesystem_Bash` - Execute bash commands
7. `filesystem_BashOutput` - Retrieve output from background shells
8. `filesystem_KillShell` - Kill background shell processes
9. `filesystem_WebFetch` - Fetch and analyze web content
10. `filesystem_WebSearch` - Search the web
11. `filesystem_LS` - List directory contents
12. `filesystem_TodoWrite` - Manage task lists
13. `filesystem_Task` - Execute complex tasks

### Code Execution Tools (prefixed with `codeMode_`)
14. `codeMode_execute` - Execute JavaScript code with embedded tools
15. `codeMode_execute_output` - Retrieve output from background executions
16. `codeMode_execute_list` - List background executions
17. `codeMode_execute_kill` - Kill background executions

## How It Works

1. **Server Startup**: The proxy spawns child processes for each configured MCP server
2. **Tool Discovery**: On startup, the proxy queries each server for its available tools
3. **Tool Registration**: Tools are registered with prefixed names to avoid conflicts
4. **Request Forwarding**: When a tool is called, the proxy forwards the request to the appropriate server
5. **Response Aggregation**: Results are returned directly from the target server

## Architecture

```
Claude -> MCP Proxy -> Multiple MCP Servers
                ├─ index.js (filesystem)
                └─ code-mode.js (code execution)
```

## Adding New Servers

To add a new MCP server, add it to the `MCP_SERVERS` array in `simple-mcp-proxy.js`:

```javascript
{
  name: 'myServer',
  command: 'node',
  args: ['my-server.js'],
  description: 'My custom MCP server'
}
```

## Features

- **Simple Architecture**: No complex dependencies, just stdio communication
- **Error Handling**: Graceful handling of server failures
- **Tool Prefixing**: Automatic prefixing to avoid naming conflicts
- **Timeout Management**: Built-in timeouts for all requests
- **Graceful Shutdown**: Clean shutdown of all child processes

## Benefits

- **Unified Interface**: Access multiple MCP servers through a single connection
- **No SDK Dependencies**: Works with any stdio-based MCP server
- **Minimal Footprint**: Lightweight and fast
- **Easy Configuration**: Simple array-based server configuration
- **Robust**: Handles server failures gracefully

## Testing Results

✅ Successfully connects to 2/2 MCP servers
✅ Successfully aggregates 17 tools from multiple servers
✅ Tool naming conflicts resolved with prefixes
✅ Request forwarding works correctly
✅ Graceful shutdown functioning properly

This is the simplest possible MCP proxy implementation that demonstrates the core concept of aggregating multiple MCP servers into a unified interface.