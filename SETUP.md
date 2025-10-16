# MCP Proxy Setup for Claude Code

Super simple MCP proxy that aggregates multiple MCP servers into one interface.

## Quick Setup

### 1. Add MCP Proxy to Claude Code

Add this to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "codemode": {
      "command": "node",
      "args": ["/path/to/your/project/proxy.js"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

**Important:** Replace `/path/to/your/project` with the actual path to this project directory.

### 2. Configure MCP Servers

Create `.codemode.json` in your project directory OR `~/.claude/.codemode.json` for global config:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["index.js"]
    },
    "codeMode": {
      "command": "node",
      "args": ["code-mode.js"]
    },
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "."]
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"]
    }
  }
}
```

### 3. Restart Claude Code

Restart Claude Code to load the new MCP server.

## How It Works

1. **Configuration**: Proxy reads from `.codemode.json` (local) or `~/.claude/.codemode.json` (global)
2. **Aggregation**: Starts all configured MCP servers and collects their tools
3. **Proxying**: Exposes all tools with prefixed names (`filesystem_Read`, `git_Clone`, etc.)
4. **Forwarding**: Forwards tool calls to the appropriate server

## Available Tools

After setup, you'll have access to all tools from configured servers with prefixed names:

- `filesystem_Read` - Read files
- `filesystem_Write` - Write files
- `filesystem_Edit` - Edit files
- `codeMode_execute` - Execute code
- `git_Clone` - Git operations (if configured)
- `brave-search_search` - Web search (if configured)

## Configuration Options

### Local Configuration (.codemode.json)
Project-specific MCP servers. Used first if it exists.

### Global Configuration (~/.claude/.codemode.json)
User-wide MCP servers. Used as fallback.

### Adding New Servers

Add to your `.codemode.json`:

```json
{
  "mcpServers": {
    "myServer": {
      "command": "node",
      "args": ["my-mcp-server.js"]
    }
  }
}
```

## Popular MCP Servers

Add these to your `.codemode.json`:

### Git Server
```json
"git": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "."]
}
```

### Brave Search Server
```json
"brave-search": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-brave-search"]
}
```

### GitHub Server
```json
"github": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"]
}
```

## Troubleshooting

### Server Not Starting
- Check if the command/args are correct
- Verify the file paths exist
- Check stderr output in Claude Code logs

### Tools Not Showing Up
- Restart Claude Code
- Check `.codemode.json` syntax
- Verify MCP servers are working standalone

### Permission Issues
- Make sure Node.js has permission to access files
- Check if `npx -y` works for installing packages

## Development

### Test the Proxy
```bash
node proxy.js
```

### Test Configuration
```bash
# Test with local config
node proxy.js

# Test with global config
rm .codemode.json
node proxy.js
```

## Files

- `proxy.js` - Main proxy server (100 lines)
- `.codemode.json` - Configuration file (local)
- `~/.claude/.codemode.json` - Configuration file (global)
- `index.js` - File system MCP server
- `code-mode.js` - Code execution MCP server

That's it! Super simple MCP proxy with configuration-driven setup.