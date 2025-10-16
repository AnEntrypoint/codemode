# Claude Agent SDK Limitations and Solution

## Summary
The `@anthropic-ai/claude-agent-sdk` (v0.1.19) has fundamental issues that make it unsuitable for production use as of October 2025.

## Discovered Issues

### 1. createSdkMcpServer is Broken
- **GitHub Issue**: #6710 - "SDK MCP server fails to connect due to closed stream"
- **Status**: Confirmed broken across multiple CLI versions
- **Error**: `Failed to connect SDK MCP server: Error: Stream closed`
- **Impact**: In-process tool definitions don't work

### 2. Query Function Hangs Indefinitely
- **Issue**: The `query()` function hangs even without MCP servers
- **Timeout**: Never returns, causes process to hang indefinitely
- **Windows Specific**: Known subprocess communication issues on Windows
- **Impact**: Basic SDK functionality is non-functional

### 3. Stdio Transport Issues
- **Problem**: MCP server communication via stdio fails
- **Symptoms**: Timeouts during tools/list requests
- **Root Cause**: Protocol initialization failures between SDK and MCP servers

## Authentication Requirements

### Claude CLI vs API Keys
- **SDK Design**: Intended to work with Claude CLI authentication (Pro/Max subscription)
- **API Key Support**: Can use `ANTHROPIC_API_KEY` environment variable
- **Issue**: Even with proper authentication, the SDK still hangs

## Working Solution: Minimal Agent

Since the SDK approach is fundamentally broken, we implemented a direct JavaScript execution approach:

### Architecture
1. **No SDK Dependency**: Direct Node.js execution
2. **Simple Tools**: Basic implementations of Read, Write, Edit, Glob, Bash
3. **No MCP Complexity**: Direct file system and process operations
4. **Working Configuration**: Functions without external dependencies

### Benefits
- ✅ Works reliably
- ✅ No timeouts or hangs
- ✅ Simple architecture
- ✅ Easy to maintain
- ✅ No authentication required for basic operations

### Limitations
- ❌ No direct Claude AI integration (would need separate API calls)
- ❌ Basic tool set only
- ❌ No MCP server integration

## Recommendations

### When SDK is Available
If future SDK versions fix these issues:
1. Test with simple stdio MCP servers first
2. Verify createSdkMcpServer functionality
3. Use Claude CLI authentication for Pro/Max subscriptions
4. Document the authentication method required

### Current Working Approach
1. Use direct JavaScript execution for simple automation
2. Implement custom tools as needed
3. For AI integration, use direct Anthropic API calls separately
4. Keep architecture simple and maintainable

## Files
- `agent.js` - Broken SDK implementation (DO NOT USE)
- `minimal-agent.js` - Working direct execution approach
- `simple-agent.js` - Attempted MCP server approach (also hangs)

## Testing Command
```bash
# Works:
node minimal-agent.js --agent "list JavaScript files"

# Broken (hangs indefinitely):
node agent.js --agent "any task"
```

## Conclusion
The Claude Agent SDK is not production-ready as of v0.1.19. Use direct execution approaches until the fundamental issues are resolved.