# Code Mode - Async Execute Tool with Embedded Functions

## Overview

Code Mode provides a **single `execute` tool** that runs JavaScript code with all file system and command execution functions available as built-in functions.

### Key Features
- **Async Execution**: Automatically switches to background execution after 30 seconds
- **File System Functions**: Read, Write, Edit, Glob, Grep, Bash, LS available as JavaScript functions
- **Background Process Management**: Query, list, and kill long-running executions
- **Cross-Language Tool**: CLI tool available for use from any programming language

## Architecture

### Tool Suite
- **execute**: Main execution tool with embedded functions
- **execute_output**: Retrieve output from background executions
- **execute_list**: List all running/completed background executions
- **execute_kill**: Kill a running background execution

### Async Execution Model

1. **Quick Executions (< 30s)**: Returns immediately with full output
2. **Long Executions (> 30s)**:
   - Returns partial output after 30 seconds
   - Provides execution ID for later querying
   - Process continues running in background
   - Use `execute_output` to retrieve results

### How It Works

1. Creates temporary CommonJS modules with all tool functions
2. Injects functions into execution environment
3. Spawns Node.js process with enhanced environment (PATH includes tools/)
4. Monitors execution time and switches to async if needed
5. Cleans up temporary files after execution

## Available Functions

All functions are available globally in executed code:

### File Operations
- `Read(file_path, offset, limit)` - Read file with line numbers (→ format)
- `Write(file_path, content)` - Write/overwrite files
- `Edit(file_path, old_string, new_string, replace_all)` - String replacement in files

### Search & Discovery
- `Glob(pattern, path)` - Fast glob pattern matching (`**/*.js`, etc.)
- `Grep(pattern, path, options)` - Powerful ripgrep search

### Command Execution
- `Bash(command, description, timeout)` - Execute bash commands
- `LS(path, show_hidden, recursive)` - List directory contents

### Features
- All paths relative to `workingDirectory`
- 30,000 character output limit
- 2,000 line default for Read
- 2,000 char/line truncation
- Working directory validation from mcp-repl
- Proper error handling and timeouts

## Usage Examples

### Basic File Reading
```javascript
{
  "code": "console.log(Read('package.json', 0, 5));"
}
```

Output:
```
    1→{
    2→  "name": "my-project",
    3→  "version": "1.0.0",
    4→  "description": "...",
    5→  "main": "index.js",
```

### File Writing
```javascript
{
  "code": "console.log(Write('output.txt', 'Hello World!'));"
}
```

Output:
```
Successfully created file: /path/to/output.txt
```

### Glob Pattern Search
```javascript
{
  "code": "Glob('**/*.js').then(files => console.log(files));"
}
```

Output:
```
index.js
src/main.js
test/test.js
...
```

### Command Execution
```javascript
{
  "code": "Bash('ls -la').then(output => console.log(output));"
}
```

### Directory Listing
```javascript
{
  "code": "console.log(LS('.', false, false));"
}
```

Output:
```
package.json (685 bytes)
index.js (42389 bytes)
README.md (10374 bytes)
node_modules/
...
```

### Complex Operations
```javascript
{
  "code": `
    const content = Read('config.json');
    console.log('Original:', content);

    Write('config.backup.json', content);
    console.log('Backup created');

    Edit('config.json', '"debug": false', '"debug": true');
    console.log('Config updated');

    const newContent = Read('config.json');
    console.log('New:', newContent);
  `
}
```

## Tool Schema

```json
{
  "name": "execute",
  "description": "Execute code with embedded file system functions",
  "inputSchema": {
    "type": "object",
    "properties": {
      "workingDirectory": {
        "type": "string",
        "description": "Path to working directory",
        "required": true
      },
      "code": {
        "type": "string",
        "description": "JavaScript code with Read, Write, Edit, Glob, Grep, Bash, LS functions"
      },
      "commands": {
        "type": ["string", "array"],
        "description": "Bash commands (alternative to code)"
      },
      "runtime": {
        "type": "string",
        "enum": ["nodejs", "deno", "bash", "go", "rust", "python", "c", "cpp", "auto"],
        "default": "auto"
      },
      "timeout": {
        "type": "number",
        "default": 240000,
        "description": "Timeout in milliseconds"
      }
    }
  }
}
```

## Runtime Support

### Auto-Detection (default)
Automatically detects whether to use:
- `bash` - for shell commands (`npm`, `git`, `ls`, etc.)
- `nodejs` - for JavaScript code (default)

### Explicit Runtimes
- `nodejs` - Node.js JavaScript (with tool functions)
- `deno` - Deno JavaScript/TypeScript
- `bash` - Bash shell commands
- `go` - Go programming language
- `rust` - Rust (with compilation)
- `python` - Python 3
- `c` - C (with compilation)
- `cpp` - C++ (with compilation)

## Technical Details

### Working Directory Detection
Uses mcp-repl's working directory validation:
- Resolves relative paths
- Validates existence
- Returns absolute path

### Module Generation
Creates temporary module at runtime:
```javascript
/tmp/codemode_tools_<timestamp>.js
```

Contains all tool functions with proper scoping and error handling.

### Cleanup
- Temporary module deleted after execution
- No persistent state
- Each execution is isolated

### Output Limits
- Tool output: 30,000 characters max
- Read default: 2,000 lines
- Line truncation: 2,000 characters
- Bash timeout: 120s default, 600s max

### Error Handling
- File not found errors
- Permission denied errors
- Timeout errors
- Command execution errors
- Working directory validation errors

## Testing

```bash
# Start server
node code-mode.js

# Run tests
node test-code-mode-comprehensive.js
```

## Comparison: Regular Mode vs Code Mode

### Regular Mode (index.js)
- **14 separate tools**: Read, Write, Edit, Glob, Grep, Bash, etc.
- Each operation requires separate tool call
- Multiple round trips for complex operations

### Code Mode (code-mode.js)
- **1 tool**: execute
- All operations in single code block
- Functions available directly in code
- Single round trip for complex operations

## Use Cases

### Best for Code Mode
- Complex multi-step operations
- File transformations
- Batch processing
- Conditional logic based on file contents
- When you want to "write code" not "call tools"

### Best for Regular Mode
- Simple single operations
- When LLM should choose tool
- Following Claude Code's exact behavior
- Compatibility with existing integrations

## Status

✅ Fully Functional
- Single execute tool working with async execution
- **30-second async threshold**: Automatically moves long executions to background
- **Background execution management**: Query, list, and kill long-running processes
- All functions embedded and accessible (Read, Write, Edit, Glob, Grep, Bash, LS)
- Working directory validation integrated
- Proper error handling and timeouts
- 30k character output limits enforced
- Clean module generation and cleanup
- **Comprehensive test suite passing**: Basic integration + async execution tests

## Files

- `code-mode.js` - Main server implementation with async execution
- `test-runner.cjs` - Basic integration test (4 operations)
- `test-async-execution.cjs` - Comprehensive async execution test suite
- `tools/codemode-tool` - CLI wrapper for cross-language tool access
- `CODE-MODE-README.md` - This file
