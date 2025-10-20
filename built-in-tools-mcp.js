#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve as resolvePath, dirname, basename } from 'path';
import { randomUUID } from 'crypto';
import fg from 'fast-glob';
import { Readability } from '@mozilla/readability';
import fetch from 'node-fetch';
import ASTLinter, { isAstGrepAvailable } from './ast-grep-wrapper.js';
import {
  ToolError,
  ValidationError,
  ExecutionError,
  SearchError,
  ASTError,
  PatternError,
  ToolErrorHandler,
  ASTPatternValidator
} from './ast-error-handling.js';

class ASTModificationHelper {
  constructor(workingDirectory = process.cwd()) {
    this.workingDirectory = workingDirectory;
  }

  detectLanguageFromExtension(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const extensionMap = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.mjs': 'javascript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.c': 'c',
      '.cpp': 'cpp',
      '.cc': 'cpp',
      '.cxx': 'cpp'
    };
    return extensionMap[ext] || 'javascript';
  }

  async parseCode(code, language) {
    if (!(await isAstGrepAvailable())) {
      throw new Error('AST functionality not available');
    }
    const { parse } = await import('./ast-grep-wrapper.js');
    return await parse(language, code);
  }

  async searchPatternInFile(filePath, pattern, options = {}) {
    const {
      language = null,
      maxMatches = 100,
      includeContext = false
    } = options;

    try {
      if (!existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const content = readFileSync(filePath, 'utf8');
      const detectedLanguage = language || this.detectLanguageFromExtension(filePath);

      const root = await this.parseCode(content, detectedLanguage);
      if (!root) {
        return { success: false, error: 'Failed to parse code' };
      }

      const rootNode = root.root();
      const matches = rootNode.findAll(pattern);

      const results = matches.slice(0, maxMatches).map(match => {
        const range = match.range();
        const result = {
          file: filePath,
          line: range.start.line,
          column: range.start.column,
          text: match.text(),
          start: range.start.index,
          end: range.end.index
        };

        if (includeContext) {
          const lines = content.split('\n');
          const contextStart = Math.max(0, range.start.line - 2);
          const contextEnd = Math.min(lines.length - 1, range.start.line + 2);
          result.context = lines.slice(contextStart, contextEnd + 1).map((line, idx) => ({
            line: contextStart + idx + 1,
            content: line,
            isMatch: contextStart + idx === range.start.line
          }));
        }

        return result;
      });

      return {
        success: true,
        results,
        totalMatches: matches.length,
        truncated: matches.length > maxMatches
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async searchPatternInDirectory(dirPath, pattern, options = {}) {
    const {
      recursive = true,
      extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
      maxFiles = 100,
      maxMatchesPerFile = 50,
      language = null
    } = options;

    const allResults = [];
    let filesProcessed = 0;

    const processDirectory = async (currentDir, depth = 0) => {
      if (depth > 5 || filesProcessed >= maxFiles) return;

      try {
        const entries = readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          if (filesProcessed >= maxFiles) break;

          const fullPath = join(currentDir, entry.name);

          if (entry.isDirectory() && recursive) {
            // Skip common ignore directories
            if (!['node_modules', '.git', '.vscode', '.idea', 'dist', 'build', 'coverage'].includes(entry.name)) {
              await processDirectory(fullPath, depth + 1);
            }
          } else if (entry.isFile() && extensions.some(ext => fullPath.endsWith(ext))) {
            filesProcessed++;
            const result = await this.searchPatternInFile(fullPath, pattern, {
              language,
              maxMatches: maxMatchesPerFile,
              includeContext: options.includeContext
            });

            if (result.success && result.results.length > 0) {
              allResults.push(...result.results);
            }
          }
        }
      } catch (error) {
        // Skip unreadable directories
      }
    };

    await processDirectory(dirPath);

    return {
      success: true,
      results: allResults,
      filesProcessed,
      totalMatches: allResults.length
    };
  }

  async replacePatternInFile(filePath, pattern, replacement, options = {}) {
    const { language = null, dryRun = false } = options;

    try {
      if (!existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const content = readFileSync(filePath, 'utf8');
      const detectedLanguage = language || this.detectLanguageFromExtension(filePath);

      const root = await this.parseCode(content, detectedLanguage);
      if (!root) {
        return { success: false, error: 'Failed to parse code' };
      }

      const rootNode = root.root();
      const matches = rootNode.findAll(pattern);

      if (matches.length === 0) {
        return {
          success: true,
          modified: false,
          matchesFound: 0,
          message: 'No matches found for pattern'
        };
      }

      // Apply replacements in reverse order to maintain position accuracy
      const sortedMatches = matches.sort((a, b) => b.range().start.index - a.range().start.index);
      let modifiedContent = content;
      let totalOffset = 0;

      const changes = [];

      for (const match of sortedMatches) {
        const range = match.range();
        const before = modifiedContent.substring(0, range.start.index + totalOffset);
        const after = modifiedContent.substring(range.end.index + totalOffset);

        modifiedContent = before + replacement + after;
        totalOffset += replacement.length - (range.end.index - range.start.index);

        changes.push({
          line: range.start.line,
          column: range.start.column,
          original: match.text(),
          replacement: replacement
        });
      }

      if (!dryRun && modifiedContent !== content) {
        writeFileSync(filePath, modifiedContent);
      }

      return {
        success: true,
        modified: modifiedContent !== content,
        matchesFound: matches.length,
        changes,
        dryRun,
        message: dryRun ?
          `Dry run: Would make ${matches.length} changes` :
          `Successfully applied ${matches.length} changes`
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async replacePatternInDirectory(dirPath, pattern, replacement, options = {}) {
    const {
      recursive = true,
      extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
      maxFiles = 50,
      language = null,
      dryRun = false
    } = options;

    const allResults = [];
    let filesProcessed = 0;
    let filesModified = 0;

    const processDirectory = async (currentDir, depth = 0) => {
      if (depth > 5 || filesProcessed >= maxFiles) return;

      try {
        const entries = readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          if (filesProcessed >= maxFiles) break;

          const fullPath = join(currentDir, entry.name);

          if (entry.isDirectory() && recursive) {
            // Skip common ignore directories
            if (!['node_modules', '.git', '.vscode', '.idea', 'dist', 'build', 'coverage'].includes(entry.name)) {
              await processDirectory(fullPath, depth + 1);
            }
          } else if (entry.isFile() && extensions.some(ext => fullPath.endsWith(ext))) {
            filesProcessed++;
            const result = await this.replacePatternInFile(fullPath, pattern, replacement, {
              language,
              dryRun
            });

            if (result.success) {
              allResults.push({
                file: fullPath,
                ...result
              });

              if (result.modified) {
                filesModified++;
              }
            }
          }
        }
      } catch (error) {
        // Skip unreadable directories
      }
    };

    await processDirectory(dirPath);

    return {
      success: true,
      results: allResults,
      filesProcessed,
      filesModified,
      totalChanges: allResults.reduce((sum, r) => sum + r.matchesFound, 0),
      dryRun
    };
  }

  generateASTInsights(results, operation, pattern, replacement = null) {
    const insights = [];

    if (operation === 'search') {
      insights.push(`AST search found ${results.length} matches for pattern: "${pattern}"`);

      const uniqueFiles = new Set(results.map(r => r.file));
      if (uniqueFiles.size > 1) {
        insights.push(`Pattern found in ${uniqueFiles.size} different files`);
      }

      if (pattern.includes('$') || pattern.includes('has')) {
        insights.push('Complex pattern search - results show structural code relationships');
      }

      const fileTypes = new Set(results.map(r => r.file.split('.').pop()));
      if (fileTypes.size > 1) {
        insights.push(`Pattern spans ${fileTypes.size} file types: ${Array.from(fileTypes).join(', ')}`);
      }

    } else if (operation === 'replace') {
      if (replacement) {
        insights.push(`Pattern replacement: "${pattern}" → "${replacement}"`);
      }

      const totalChanges = results.reduce((sum, r) => sum + (r.matchesFound || 0), 0);
      insights.push(`Total changes: ${totalChanges} across ${results.length} files`);

      if (totalChanges > 10) {
        insights.push('Large-scale change - consider testing and verification');
      }
    }

    // Pattern-specific insights
    if (pattern.includes('console.')) {
      insights.push('Console operation pattern detected');
    }

    if (pattern.includes('debugger')) {
      insights.push('Debugger statement pattern detected');
    }

    if (pattern.includes('var ')) {
      insights.push('Var declaration pattern detected - consider modernizing to const/let');
    }

    if (pattern.includes('TODO') || pattern.includes('FIXME')) {
      insights.push('Task comment pattern detected');
    }

    if (results.length === 0) {
      insights.push('No matches found - pattern may be too specific or not present');
    } else if (results.length > 50) {
      insights.push('Many matches found - consider more specific pattern');
    }

    return insights;
  }
}

const server = new Server(
  {
    name: 'codemode-built-in-tools',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'Read',
        description: 'Read file content from the filesystem. Returns a string with line numbers prefixed (format: "    1→content"). NOT an object - use the result directly as a string. Supports reading specific ranges with offset and limit parameters.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path to the file to read (relative to working directory)' },
            offset: { type: 'number', description: 'Line number to start reading from (optional)' },
            limit: { type: 'number', description: 'Number of lines to read (optional, default 2000)' }
          },
          required: ['file_path']
        }
      },
      {
        name: 'Write',
        description: 'Write content to a file, creating it if it doesn\'t exist or overwriting if it does. Creates parent directories as needed. Returns null on success, throws error on failure.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path to the file to write' },
            content: { type: 'string', description: 'Content to write to the file' }
          },
          required: ['file_path', 'content']
        }
      },
      {
        name: 'Edit',
        description: 'Edit a file by replacing exact string matches. Can replace first occurrence or all occurrences.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path to the file to edit' },
            old_string: { type: 'string', description: 'String to find and replace' },
            new_string: { type: 'string', description: 'String to replace with' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' }
          },
          required: ['file_path', 'old_string', 'new_string']
        }
      },
      {
        name: 'Glob',
        description: 'Find files matching a glob pattern. Returns an array of file path strings sorted by modification time. Use as array, not as string.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts")' },
            path: { type: 'string', description: 'Directory to search in (optional, defaults to working directory)' },
            as_array: { type: 'boolean', description: 'Return results as array instead of string (default: false)' }
          },
          required: ['pattern']
        }
      },
      {
        name: 'Grep',
        description: 'Search for patterns in files using ripgrep. Supports regex patterns, file filtering, and various output modes.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regular expression pattern to search for' },
            path: { type: 'string', description: 'File or directory to search (default: current directory)' },
            options: {
              type: 'object',
              description: 'Search options',
              properties: {
                glob: { type: 'string' },
                type: { type: 'string' },
                output_mode: { type: 'string' },
                '-i': { type: 'boolean' },
                '-n': { type: 'boolean' },
                '-A': { type: 'number' },
                '-B': { type: 'number' },
                '-C': { type: 'number' },
                multiline: { type: 'boolean' },
                head_limit: { type: 'number' }
              }
            }
          },
          required: ['pattern']
        }
      },
      {
        name: 'Bash',
        description: 'Execute shell commands. Supports timeout and captures both stdout and stderr.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            description: { type: 'string', description: 'Description of what the command does (optional)' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (max 600000, default 120000)' }
          },
          required: ['command']
        }
      },
      {
        name: 'LS',
        description: 'List directory contents with file sizes. Supports hidden files and recursive listing. Can return as array or string.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list (default: current directory)' },
            show_hidden: { type: 'boolean', description: 'Show hidden files (default: false)' },
            recursive: { type: 'boolean', description: 'List recursively (default: false)' },
            as_array: { type: 'boolean', description: 'Return results as array of objects instead of string (default: false)' }
          },
          required: []
        }
      },
      {
        name: 'TodoWrite',
        description: 'Write todo list to console for task tracking.',
        inputSchema: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              description: 'Array of todo items',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                  activeForm: { type: 'string' }
                }
              }
            }
          },
          required: ['todos']
        }
      },
      {
        name: 'WebFetch',
        description: 'Fetch a webpage and extract readable plain text content using Mozilla Readability. Returns article title, byline, excerpt, and clean text content.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL of the webpage to fetch' }
          },
          required: ['url']
        }
      },
      {
        name: 'ASTLint',
        description: 'Universal AST-based linting tool that works across all codebases. Runs on JavaScript, TypeScript, JSX, TSX files and reports only actual issues without false positives.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to file or directory to lint (relative to working directory)' },
            recursive: { type: 'boolean', default: true, description: 'Whether to lint directories recursively' },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description: 'File extensions to lint (default: .js, .jsx, .ts, .tsx, .mjs)'
            },
            maxFiles: { type: 'number', default: 100, description: 'Maximum number of files to process' },
            groupBy: {
              type: 'string',
              enum: ['severity', 'file'],
              default: 'severity',
              description: 'How to group the linting results'
            }
          },
          required: ['path']
        }
      },
      {
        name: 'ASTSearch',
        description: 'Search for AST patterns in files or directories. Supports complex structural patterns with metavariables like $VAR, $FUNC, $$$',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to file or directory to search (absolute or relative to working directory)' },
            pattern: { type: 'string', description: 'AST pattern: $VAR (variable), $FUNC (function), $$$ (any code). Examples: "useState($INIT)", "function $F($P)", "$F has debugger", "kind: function_declaration"' },
            language: { type: 'string', enum: ['javascript', 'typescript', 'jsx', 'tsx', 'python', 'go', 'rust', 'c', 'cpp'], description: 'Language to use for parsing (auto-detected if not specified)' },
            recursive: { type: 'boolean', default: true, description: 'Search recursively in directories' },
            maxFiles: { type: 'number', default: 100, description: 'Maximum number of files to process' },
            maxMatches: { type: 'number', default: 50, description: 'Maximum matches per file' },
            includeContext: { type: 'boolean', default: false, description: 'Include surrounding lines in results' }
          },
          required: ['path', 'pattern']
        }
      },
      {
        name: 'ASTReplace',
        description: 'Replace AST patterns in files or directories. Powerful code transformation tool with dry-run support',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to file or directory to modify (absolute or relative to working directory)' },
            pattern: { type: 'string', description: 'AST pattern to find and replace. Examples: "var $NAME", "console.log($$$)", "debugger"' },
            replacement: { type: 'string', description: 'Replacement text for the AST pattern' },
            language: { type: 'string', enum: ['javascript', 'typescript', 'jsx', 'tsx', 'python', 'go', 'rust', 'c', 'cpp'], description: 'Language to use for parsing (auto-detected if not specified)' },
            recursive: { type: 'boolean', default: true, description: 'Apply recursively in directories' },
            maxFiles: { type: 'number', default: 50, description: 'Maximum number of files to process' },
            dryRun: { type: 'boolean', default: false, description: 'Show what would be changed without actually modifying files' }
          },
          required: ['path', 'pattern', 'replacement']
        }
      },
      {
        name: 'ASTModify',
        description: 'Advanced AST modification with support for complex transformations and safety checks',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to file or directory to modify' },
            transformations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  pattern: { type: 'string', description: 'AST pattern to match' },
                  replacement: { type: 'string', description: 'Replacement text' },
                  description: { type: 'string', description: 'Description of this transformation' }
                },
                required: ['pattern', 'replacement']
              },
              description: 'Array of transformations to apply in order'
            },
            language: { type: 'string', enum: ['javascript', 'typescript', 'jsx', 'tsx', 'python', 'go', 'rust', 'c', 'cpp'], description: 'Language to use for parsing' },
            dryRun: { type: 'boolean', default: false, description: 'Show what would be changed without actually modifying files' },
            recursive: { type: 'boolean', default: true, description: 'Apply recursively in directories' },
            maxFiles: { type: 'number', default: 50, description: 'Maximum number of files to process' }
          },
          required: ['path', 'transformations']
        }
      },
      {
        name: 'execute',
        description: 'Execute JavaScript code in a persistent server environment with access to file operations, search, and management functions',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'JavaScript code to execute in the persistent server environment' }
          },
          required: ['code']
        }
      }
    ]
  };
});

// Automatic linting for file operations
async function runAutoLint(args, operation) {
  // Only run linting for file modification operations
  if (!['Write', 'Edit'].includes(operation)) {
    return null;
  }

  try {
    if (!(await isAstGrepAvailable())) {
      return null;
    }

    const filePath = args.file_path;
    if (!filePath) {
      return null;
    }

    const targetPath = resolvePath(process.cwd(), filePath);

    if (!existsSync(targetPath)) {
      return null;
    }

    const linter = new ASTLinter(process.cwd());
    const result = await linter.lintFile(targetPath);

    if (!result.available || !result.issues || result.issues.length === 0) {
      return null; // No issues found
    }

    const formattedOutput = linter.formatIssues(result.issues, {
      groupBy: 'severity',
      includePattern: false
    });

    return `\n\n🔍 Auto-lint Results (${operation} operation):
${formattedOutput}`;

  } catch (error) {
    // Silently fail linting - don't break the main operation
    return null;
  }
}

// Project-wide linting after any execution
async function runProjectWideLint() {
  try {
    if (!(await isAstGrepAvailable())) {
      return null;
    }

    const linter = new ASTLinter(process.cwd());
    const result = await linter.lintProjectWide();

    if (!result.available) {
      return null;
    }

    // Only report if there are issues
    if (!result.mostProblematicFile) {
      return null; // No issues found across the project
    }

    const report = linter.formatMostProblematicFileReport(result.mostProblematicFile, result.summary);

    return `\n\n${report}`;

  } catch (error) {
    // Silently fail project-wide linting
    return null;
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'Read':
        result = await handleRead(args);
        break;
      case 'Write':
        result = await handleWrite(args);
        break;
      case 'Edit':
        result = await handleEdit(args);
        break;
      case 'Glob':
        result = await handleGlob(args);
        break;
      case 'Grep':
        result = await handleGrep(args);
        break;
      case 'Bash':
        result = await handleBash(args);
        break;
      case 'LS':
        result = await handleLS(args);
        break;
      case 'TodoWrite':
        result = await handleTodoWrite(args);
        break;
      case 'WebFetch':
        result = await handleWebFetch(args);
        break;
      case 'ASTLint':
        result = await handleASTLint(args);
        break;
      case 'ASTSearch':
        result = await handleASTSearch(args);
        break;
      case 'ASTReplace':
        result = await handleASTReplace(args);
        break;
      case 'ASTModify':
        result = await handleASTModify(args);
        break;
      case 'execute':
        result = await handleExecute(args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    // Run automatic linting for file operations
    const lintResult = await runAutoLint(args, name);
    if (lintResult) {
      result += lintResult;
    }

    // Run project-wide linting after any execution
    const projectLintResult = await runProjectWideLint();
    if (projectLintResult) {
      result += projectLintResult;
    }

    return {
      content: [{
        type: 'text',
        text: result
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
});

async function handleRead(args) {
  const { file_path, offset, limit } = args;
  const absPath = resolvePath(process.cwd(), file_path);

  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  let content = readFileSync(absPath, 'utf8');
  if (content === '') {
    return `<system-reminder>File exists but has empty contents: ${absPath}</system-reminder>`;
  }

  const lines = content.split('\n');
  const start = offset || 0;
  const defaultLimit = 2000;
  const end = limit ? start + limit : Math.min(start + defaultLimit, lines.length);
  const selectedLines = lines.slice(start, end);

  const numberedLines = selectedLines.map((line, index) => {
    const lineNum = start + index + 1;
    const truncatedLine = line.length > 2000 ? line.substring(0, 2000) : line;
    return `${lineNum.toString().padStart(5)}→${truncatedLine}`;
  });

  let result = numberedLines.join('\n');
  if (result.length > 30000) {
    result = result.substring(0, 30000);
  }

  return result;
}

async function handleWrite(args) {
  const { file_path, content } = args;
  const absPath = resolvePath(process.cwd(), file_path);
  const fileExists = existsSync(absPath);

  if (fileExists) {
    const existingContent = readFileSync(absPath, 'utf8');
    if (existingContent === content) {
      return `File unchanged: ${absPath} (content is identical)`;
    }
  }

  const dir = dirname(absPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // ESCAPE-SAFE: Apply MCP corruption protection
  const safeContent = applyEscapeSafeTransformation(content);
  writeFileSync(absPath, safeContent, 'utf8');

  const action = fileExists ? 'overwrote' : 'created';
  const corruptionProtection = safeContent !== content ? ' with MCP corruption protection' : '';
  return `Successfully ${action} file: ${absPath}${corruptionProtection}`;
}

// ESCAPE-SAFE: Transformation function to prevent MCP corruption
function applyEscapeSafeTransformation(content) {
  let safeContent = content;
  let transformationsApplied = [];

  // Replace vulnerable regex literals with RegExp constructors
  if (safeContent.match(/\/.*\\`.*\/g/)) {
    safeContent = safeContent.replace(/\/([^/]*\\`[^/]*)\/g/g, (match, pattern) => {
      const safePattern = pattern.replace(/\\`/g, '\\\\`');
      transformationsApplied.push('regex-literal-to-constructor');
      return `new RegExp('${safePattern}', 'g')`;
    });
  }

  // Replace vulnerable template literals with safe alternatives
  if (safeContent.includes('\\`')) {
    // Convert template literals with escaped backticks to safer patterns
    safeContent = safeContent.replace(/`([^`]*\\`[^`]*)`/g, (match, innerContent) => {
      const safeContent = innerContent.replace(/\\`/g, '\\\\`');
      if (safeContent.includes('${')) {
        // Keep template literal but fix escapes
        transformationsApplied.push('template-literal-escape-fix');
        return `\`${safeContent}\``;
      } else {
        // Convert to regular string
        transformationsApplied.push('template-to-string');
        return `'${safeContent}'`;
      }
    });
  }

  // Fix nested escape sequences
  if (safeContent.includes('\\\\\\`')) {
    safeContent = safeContent.replace(/\\\\\\`/g, '\\\\`');
    transformationsApplied.push('nested-escape-fix');
  }

  // Store transformation info for debugging
  if (transformationsApplied.length > 0) {
    console.warn(`[MCP Corruption Protection] Applied transformations: ${transformationsApplied.join(', ')}`);
  }

  return safeContent;
}

async function handleEdit(args) {
  const { file_path, old_string, new_string, replace_all = false } = args;
  const absPath = resolvePath(process.cwd(), file_path);

  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  if (old_string === new_string) {
    return 'No changes made: old_string and new_string are identical';
  }

  let content = readFileSync(absPath, 'utf8');
  const originalContent = content;

  // ESCAPE-SAFE: Apply corruption protection to new_string
  const safeNewString = applyEscapeSafeTransformation(new_string);

  if (replace_all) {
    if (!content.includes(old_string)) {
      throw new Error(`String not found in file: ${old_string}`);
    }
    content = content.split(old_string).join(safeNewString);
  } else {
    const index = content.indexOf(old_string);
    if (index === -1) {
      throw new Error(`String not found in file: ${old_string}`);
    }
    content = content.substring(0, index) + safeNewString + content.substring(index + old_string.length);
  }

  if (content !== originalContent) {
    writeFileSync(absPath, content, 'utf8');
  }

  const action = replace_all ? 'replaced all occurrences' : 'replaced';
  return `Successfully ${action} in file: ${absPath}`;
}

async function handleGlob(args) {
  const { pattern, path, as_array = false } = args;
  const cwd = path ? resolvePath(process.cwd(), path) : process.cwd();

  const files = await fg(pattern, {
    cwd,
    absolute: false,
    dot: true,
    onlyFiles: true,
    stats: true
  });

  const sortedFiles = files
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
    .map(entry => typeof entry === 'string' ? entry : entry.path);

  if (as_array) {
    // Return JSON array for programmatic use
    return JSON.stringify(sortedFiles.slice(0, 1000));
  } else {
    // Return string representation (original behavior)
    let result = sortedFiles.length > 0 ? sortedFiles.join('\n') : 'No files matched';
    if (result.length > 30000) {
      result = result.substring(0, 30000);
    }
    return result;
  }
}

async function handleGrep(args) {
  const { pattern, path = '.', options = {} } = args;

  return new Promise((resolve, reject) => {
    // Handle null or undefined path by defaulting to current directory
    const safePath = path && typeof path === 'string' ? path : '.';
    const searchPath = resolvePath(process.cwd(), safePath);
    const rgArgs = [pattern, searchPath];

    if (options.glob) rgArgs.push('--glob', options.glob);
    if (options.type) rgArgs.push('--type', options.type);
    if (options['-i']) rgArgs.push('--ignore-case');
    if (options['-n']) rgArgs.push('--line-number');
    if (options.multiline) rgArgs.push('--multiline');
    if (options['-B']) rgArgs.push('--before-context', options['-B'].toString());
    if (options['-A']) rgArgs.push('--after-context', options['-A'].toString());
    if (options['-C']) rgArgs.push('--context', options['-C'].toString());

    const output_mode = options.output_mode || 'files_with_matches';
    if (output_mode === 'files_with_matches') {
      rgArgs.push('--files-with-matches');
    } else if (output_mode === 'count') {
      rgArgs.push('--count');
    }

    const child = spawn('rg', rgArgs);
    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { errorOutput += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0 && errorOutput && !errorOutput.includes('No matches found')) {
        reject(new Error(`Grep search error: ${errorOutput}`));
        return;
      }

      let result = output.trim();
      if (options.head_limit) {
        const lines = result.split('\n');
        result = lines.slice(0, options.head_limit).join('\n');
      }
      if (result.length > 30000) {
        result = result.substring(0, 30000);
      }

      resolve(result || 'No matches found');
    });
  });
}

async function handleBash(args) {
  const { command, description, timeout = 120000 } = args;

  return new Promise((resolve, reject) => {
    if (timeout > 600000) {
      reject(new Error('Timeout cannot exceed 600000ms (10 minutes)'));
      return;
    }

    if (command.includes('rm -rf /') || command.includes('sudo rm')) {
      reject(new Error('Dangerous command detected'));
      return;
    }

    const child = spawn(command, [], {
      shell: true,
      timeout,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      let output = stdout || stderr;
      const prefix = description ? `[${description}] ` : '';

      if (output.length > 30000) {
        output = output.substring(0, 30000);
      }

      if (code === 0) {
        resolve(`${prefix}${output}`);
      } else {
        reject(new Error(`${prefix}${output}`));
      }
    });

    child.on('error', (error) => {
      reject(new Error(`Command execution error: ${error.message}`));
    });
  });
}

async function handleLS(args) {
  const { path = '.', show_hidden = false, recursive = false, as_array = false } = args;
  const absPath = resolvePath(process.cwd(), path);

  if (!existsSync(absPath)) {
    throw new Error(`Path not found: ${absPath}`);
  }

  const stats = statSync(absPath);
  if (!stats.isDirectory()) {
    return `${basename(absPath)} (${stats.size} bytes)`;
  }

  function listDirectory(dirPath, prefix = '') {
    const entries = readdirSync(dirPath);
    const result = [];

    for (const entry of entries) {
      if (!show_hidden && entry.startsWith('.')) {
        continue;
      }

      const fullPath = join(dirPath, entry);
      const stats = statSync(fullPath);
      const isDir = stats.isDirectory();
      const size = isDir ? '' : ` (${stats.size} bytes)`;
      const type = isDir ? '/' : '';
      result.push(`${prefix}${entry}${type}${size}`);

      if (recursive && isDir) {
        result.push(...listDirectory(fullPath, prefix + '  '));
      }
    }

    return result;
  }

  const listing = listDirectory(absPath);

  if (as_array) {
    // Return array of file names (strings) for compatibility with agent code
    const fileArray = listing.map(item => {
      // Extract just the file/directory name without size info
      return item.replace(/\/.*$/, '').replace(/\s*\(\d+ bytes\)$/, '').trim();
    });
    // Return JSON string so it can be properly transmitted via MCP and parsed on the other end
    return JSON.stringify(fileArray.slice(0, 1000));
  } else {
    // Return string representation (original behavior)
    let result = listing.length > 0 ? listing.join('\n') : 'Empty directory';
    if (result.length > 30000) {
      result = result.substring(0, 30000);
    }
    return result;
  }
}

async function handleTodoWrite(args) {
  const { todos } = args;
  return `TodoWrite: ${JSON.stringify(todos, null, 2)}`;
}

async function handleWebFetch(args) {
  const { url } = args;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // Dynamically import JSDOM to avoid startup issues
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      return `WebFetch: Could not extract article content from ${url}. The page may not contain readable content.`;
    }

    const result = `WebFetch Results for ${url}:\n\nTitle: ${article.title}\nByline: ${article.byline || 'N/A'}\nExcerpt: ${article.excerpt || 'N/A'}\nLength: ${article.length} characters\n\nPlain Text Content:\n${article.textContent}`;

    if (result.length > 30000) {
      return result.substring(0, 30000) + '\n\n[Content truncated due to length]';
    }

    return result;

  } catch (error) {
    return `WebFetch error: ${error.message}`;
  }
}

async function handleASTLint(args) {
  const { path, recursive = true, extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs'], maxFiles = 100, groupBy = 'severity' } = args;

  try {
    if (!(await isAstGrepAvailable())) {
      return 'ASTLint: AST functionality is not available on this system. The @ast-grep/napi native binding could not be loaded.';
    }

    const targetPath = resolvePath(process.cwd(), path);

    if (!existsSync(targetPath)) {
      return `ASTLint: Path not found: ${targetPath}`;
    }

    const linter = new ASTLinter(process.cwd());

    let result;

    if (statSync(targetPath).isDirectory()) {
      // Use project-wide linting for directories
      result = await linter.lintProjectWide({
        maxFiles,
        extensions,
        workingDirectory: targetPath
      });
    } else {
      result = await linter.lintFile(targetPath);
      // Normalize format for consistency
      if (result.issues) {
        result = {
          available: result.available,
          totalIssues: result.issues.length,
          errors: result.issues.filter(i => i.severity === 'error').length,
          warnings: result.issues.filter(i => i.severity === 'warning').length,
          info: result.issues.filter(i => i.severity === 'info').length,
          files: [targetPath],
          issues: result.issues
        };
      }
    }

    if (!result.available) {
      return 'ASTLint: AST linting is not available on this system.';
    }

    // Handle project-wide linting result format
    if (result.mostProblematicFile || result.summary !== undefined) {
      // Project-wide linting result
      return linter.formatMostProblematicFileReport(result.mostProblematicFile, result.summary);
    }

    // Single file linting result format
    if (result.totalIssues === 0) {
      return '✅ ASTLint: No linting issues found';
    }

    const formattedOutput = linter.formatIssues(result.issues, {
      groupBy,
      includePattern: false
    });

    const summary = `🔍 AST Linting Results:
📁 Path: ${targetPath}
📄 Files scanned: ${result.files.length}
🚨 Errors: ${result.errors}
⚠️  Warnings: ${result.warnings}
ℹ️  Info: ${result.info}
📊 Total issues: ${result.totalIssues}

`;

    return summary + formattedOutput;

  } catch (error) {
    return `ASTLint error: ${error.message}`;
  }
}

async function handleASTSearch(args) {
  try {
    const { path, pattern, language, recursive = true, maxFiles = 100, maxMatches = 50, includeContext = false } = args;

    if (!(await isAstGrepAvailable())) {
      return 'ASTSearch: AST functionality is not available on this system.';
    }

    const targetPath = resolvePath(process.cwd(), path);

    if (!existsSync(targetPath)) {
      return `ASTSearch: Path not found: ${targetPath}`;
    }

    const helper = new ASTModificationHelper(process.cwd());

    let result;
    if (statSync(targetPath).isDirectory()) {
      result = await helper.searchPatternInDirectory(targetPath, pattern, {
        recursive,
        extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.py', '.go', '.rs', '.c', '.cpp'],
        maxFiles,
        maxMatchesPerFile: maxMatches,
        language,
        includeContext
      });
    } else {
      result = await helper.searchPatternInFile(targetPath, pattern, {
        language,
        maxMatches,
        includeContext
      });
    }

    if (!result.success) {
      return `ASTSearch error: ${result.error}`;
    }

    const insights = helper.generateASTInsights(result.results, 'search', pattern);

    let output = `🔍 AST Search Results:\n`;
    output += `📁 Path: ${targetPath}\n`;
    output += `🔍 Pattern: "${pattern}"\n`;
    output += `📊 Total matches: ${result.totalMatches}\n`;
    if (result.filesProcessed) {
      output += `📄 Files processed: ${result.filesProcessed}\n`;
    }
    output += `\n`;

    if (result.results.length === 0) {
      output += `No matches found for pattern "${pattern}"`;
    } else {
      output += `Found ${result.results.length} matches:\n\n`;

      result.results.forEach((match, index) => {
        output += `${index + 1}. ${match.file}:${match.line}:${match.column}\n`;
        output += `   ${match.text}\n`;

        if (includeContext && match.context) {
          output += `   Context:\n`;
          match.context.forEach(ctx => {
            const prefix = ctx.isMatch ? '→' : ' ';
            output += `   ${prefix} ${ctx.line}:${ctx.content}\n`;
          });
        }
        output += '\n';
      });
    }

    if (insights.length > 0) {
      output += `💡 Insights:\n`;
      insights.forEach(insight => {
        output += `• ${insight}\n`;
      });
    }

    return output.trim();

  } catch (error) {
    return `ASTSearch error: ${error.message}`;
  }
}

async function handleASTReplace(args) {
  try {
    const { path, pattern, replacement, language, recursive = true, maxFiles = 50, dryRun = false } = args;

    if (!(await isAstGrepAvailable())) {
      return 'ASTReplace: AST functionality is not available on this system.';
    }

    const targetPath = resolvePath(process.cwd(), path);

    if (!existsSync(targetPath)) {
      return `ASTReplace: Path not found: ${targetPath}`;
    }

    const helper = new ASTModificationHelper(process.cwd());

    let result;
    if (statSync(targetPath).isDirectory()) {
      result = await helper.replacePatternInDirectory(targetPath, pattern, replacement, {
        recursive,
        extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
        maxFiles,
        language,
        dryRun
      });
    } else {
      result = await helper.replacePatternInFile(targetPath, pattern, replacement, {
        language,
        dryRun
      });
    }

    if (!result.success) {
      return `ASTReplace error: ${result.error}`;
    }

    const insights = helper.generateASTInsights(result.results || [result], 'replace', pattern, replacement);

    let output = `🔄 AST Replacement Results:\n`;
    output += `📁 Path: ${targetPath}\n`;
    output += `🔍 Pattern: "${pattern}"\n`;
    output += `✏️  Replacement: "${replacement}"\n`;
    output += `${dryRun ? '🔍 DRY RUN - No files modified' : '✅ Files Modified'}\n`;
    output += `\n`;

    if (result.filesProcessed) {
      output += `📊 Summary:\n`;
      output += `• Files processed: ${result.filesProcessed}\n`;
      output += `• Files modified: ${result.filesModified}\n`;
      output += `• Total changes: ${result.totalChanges}\n\n`;
    } else {
      output += `📊 Summary:\n`;
      output += `• Matches found: ${result.matchesFound}\n`;
      output += `• Modified: ${result.modified ? 'Yes' : 'No'}\n`;
      output += `• Changes: ${result.changes ? result.changes.length : 0}\n\n`;
    }

    if (result.results && result.results.length > 0) {
      output += `📋 Changes Details:\n`;
      result.results.forEach(fileResult => {
        if (fileResult.matchesFound > 0) {
          output += `\n📄 ${fileResult.file}\n`;
          output += `   • Changes: ${fileResult.matchesFound}\n`;
          output += `   • Status: ${fileResult.modified ? 'Modified' : 'No changes needed'}\n`;
        }
      });
    } else if (result.changes && result.changes.length > 0) {
      output += `📋 Changes:\n`;
      result.changes.forEach((change, index) => {
        output += `${index + 1}. Line ${change.line}:${change.column}\n`;
        output += `   - Original: ${change.original}\n`;
        output += `   + Replacement: ${change.replacement}\n\n`;
      });
    }

    if (insights.length > 0) {
      output += `💡 Insights:\n`;
      insights.forEach(insight => {
        output += `• ${insight}\n`;
      });
    }

    return output.trim();

  } catch (error) {
    return `ASTReplace error: ${error.message}`;
  }
}

async function handleASTModify(args) {
  try {
    const { path, transformations, language, dryRun = false, recursive = true, maxFiles = 50 } = args;

    if (!(await isAstGrepAvailable())) {
      return 'ASTModify: AST functionality is not available on this system.';
    }

    const targetPath = resolvePath(process.cwd(), path);

    if (!existsSync(targetPath)) {
      return `ASTModify: Path not found: ${targetPath}`;
    }

    const helper = new ASTModificationHelper(process.cwd());

    let totalChanges = 0;
    let totalFilesModified = 0;
    let allResults = [];

    let output = `🔧 AST Modification Results:\n`;
    output += `📁 Path: ${targetPath}\n`;
    output += `🔍 Transformations: ${transformations.length}\n`;
    output += `${dryRun ? '🔍 DRY RUN - No files modified' : '✅ Files Modified'}\n\n`;

    for (let i = 0; i < transformations.length; i++) {
      const { pattern, replacement, description } = transformations[i];

      output += `Transformation ${i + 1}: ${description || pattern}\n`;
      output += `Pattern: "${pattern}" → "${replacement}"\n`;

      let result;
      if (statSync(targetPath).isDirectory()) {
        result = await helper.replacePatternInDirectory(targetPath, pattern, replacement, {
          recursive,
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
          maxFiles,
          language,
          dryRun
        });
      } else {
        result = await helper.replacePatternInFile(targetPath, pattern, replacement, {
          language,
          dryRun
        });
      }

      if (!result.success) {
        output += `❌ Error: ${result.error}\n\n`;
        continue;
      }

      if (result.filesProcessed) {
        output += `   • Files processed: ${result.filesProcessed}\n`;
        output += `   • Files modified: ${result.filesModified}\n`;
        output += `   • Changes: ${result.totalChanges}\n`;
        totalFilesModified += result.filesModified;
        totalChanges += result.totalChanges;
      } else {
        output += `   • Matches found: ${result.matchesFound}\n`;
        output += `   • Modified: ${result.modified ? 'Yes' : 'No'}\n`;
        if (result.changes) {
          output += `   • Changes: ${result.changes.length}\n`;
          totalChanges += result.changes.length;
        }
        if (result.modified) {
          totalFilesModified++;
        }
      }

      allResults.push(result);
      output += `\n`;
    }

    output += `📊 Overall Summary:\n`;
    output += `• Total transformations: ${transformations.length}\n`;
    output += `• Total files modified: ${totalFilesModified}\n`;
    output += `• Total changes: ${totalChanges}\n`;

    return output.trim();

  } catch (error) {
    return `ASTModify error: ${error.message}`;
  }
}

// Store execution workers for persistent server functionality
const executionWorkers = new Map();

async function handleMCPWorkerCall(worker, msg) {
  const { callId, tool, args } = msg;

  try {
    let result;

    // Call the appropriate tool handler
    switch (tool) {
      case 'Read':
        result = await handleRead(args);
        break;
      case 'Write':
        result = await handleWrite(args);
        break;
      case 'Edit':
        result = await handleEdit(args);
        break;
      case 'Glob':
        result = await handleGlob(args);
        break;
      case 'Grep':
        result = await handleGrep(args);
        break;
      case 'Bash':
        result = await handleBash(args);
        break;
      case 'TodoWrite':
        result = await handleTodoWrite(args);
        break;
      case 'WebFetch':
        result = await handleWebFetch(args);
        break;
      case 'LS':
        result = await handleLS(args);
        break;
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }

    // Send success result back to worker
    worker.send({
      type: 'MCP_RESULT',
      callId,
      success: true,
      result
    });

  } catch (error) {
    // Send error result back to worker
    worker.send({
      type: 'MCP_RESULT',
      callId,
      success: false,
      result: error.message
    });
  }
}

async function handleExecute(args) {
  const { code } = args;
  const workingDirectory = process.cwd();
  const execId = randomUUID();

  return new Promise((resolve, reject) => {
    // Check if we have a running execution worker for this directory
    let worker = executionWorkers.get(workingDirectory);

    if (!worker || worker.killed) {
      // Start new execution worker
      const workerPath = join(dirname(new URL(import.meta.url).pathname), 'execution-worker.js');
      worker = spawn('node', [workerPath], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        cwd: workingDirectory,
        env: { ...process.env }
      });

      worker.killed = false;
      worker.pendingResults = new Map();

      // Set up message handling
      worker.on('message', (msg) => {
        if (msg.type === 'EXEC_RESULT' && msg.execId === execId) {
          if (msg.success) {
            resolve(msg.result);
          } else {
            reject(new Error(msg.error));
          }
        } else if (msg.type === 'MCP_CALL') {
          // Handle MCP tool calls from the execution worker
          handleMCPWorkerCall(worker, msg);
        }
      });

      worker.on('error', (error) => {
        reject(new Error(`Execution worker error: ${error.message}`));
      });

      worker.on('exit', (code) => {
        worker.killed = true;
        executionWorkers.delete(workingDirectory);
        if (code !== 0) {
          reject(new Error(`Execution worker exited with code ${code}`));
        }
      });

      executionWorkers.set(workingDirectory, worker);
    }

    // Set up timeout for this specific execution
    const timeout = setTimeout(() => {
      reject(new Error('Execution timeout (30s) - use async operations for long-running tasks'));
    }, 30000);

    // Set up one-time result handler for this execution
    const resultHandler = (msg) => {
      if (msg.type === 'EXEC_RESULT' && msg.execId === execId) {
        clearTimeout(timeout);
        worker.off('message', resultHandler);
        if (msg.success) {
          resolve(msg.result);
        } else {
          reject(new Error(msg.error));
        }
      }
    };

    worker.on('message', resultHandler);

    // Initialize the worker with MCP tool functions if needed
    const toolFunctions = `
      global.Read = async (path, offset, limit) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "MCP_CALL", callId, tool: "Read", args: { path, offset, limit } });
        });
      };

      global.Write = async (path, content) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "MCP_CALL", callId, tool: "Write", args: { path, content } });
        });
      };

      global.Edit = async (path, oldString, newString, replaceAll) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "MCP_CALL", callId, tool: "Edit", args: { path, old_string: oldString, new_string: newString, replace_all: replaceAll } });
        });
      };

      global.Glob = async (pattern, path) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "MCP_CALL", callId, tool: "Glob", args: { pattern, path } });
        });
      };

      global.Grep = async (pattern, path, options) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "MCP_CALL", callId, tool: "Grep", args: { pattern, path, options } });
        });
      };

      global.Bash = async (command, description, timeout) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "MCP_CALL", callId, tool: "Bash", args: { command, description, timeout } });
        });
      };

      global.TodoWrite = async (todos) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "MCP_CALL", callId, tool: "TodoWrite", args: { todos } });
        });
      };

      global.WebFetch = async (url) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "MCP_CALL", callId, tool: "WebFetch", args: { url } });
        });
      };

      global.get_server_state = async () => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "GET_SERVER_STATE", callId });
        });
      };

      global.kill_execution = async (execId) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "KILL_EXECUTION", callId, execId });
        });
      };

      global.clear_context = async () => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "CLEAR_CONTEXT", callId });
        });
      };

      global.get_async_execution = async (execId) => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "GET_ASYNC_EXECUTION", callId, execId });
        });
      };

      global.list_async_executions = async () => {
        const callId = "${randomUUID()}";
        return new Promise((resolve, reject) => {
          worker.pendingResults.set(callId, { resolve, reject });
          worker.send({ type: "LIST_ASYNC_EXECUTIONS", callId });
        });
      };
    `;

    // Initialize tools and send execute command
    worker.send({ type: 'INIT_TOOLS', toolFunctions });

    // Wait a bit for initialization
    setTimeout(() => {
      worker.send({
        type: 'EXECUTE',
        execId,
        code,
        workingDirectory
      });
    }, 100);
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Built-in Tools MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
