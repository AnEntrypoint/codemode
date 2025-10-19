#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import ASTLinter, { isAstGrepAvailable, parse } from './ast-grep-wrapper.js';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const server = new Server(
  {
    name: 'ast-modification-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

class ASTModificationHelper {
  constructor(workingDirectory = process.cwd()) {
    this.workingDirectory = workingDirectory;
  }

  detectLanguageFromExtension(filePath) {
    const ext = path.extname(filePath).toLowerCase();
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

    const processDirectory = (currentDir, depth = 0) => {
      if (depth > 5 || filesProcessed >= maxFiles) return;

      try {
        const entries = readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          if (filesProcessed >= maxFiles) break;

          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory() && recursive) {
            // Skip common ignore directories
            if (!['node_modules', '.git', '.vscode', '.idea', 'dist', 'build', 'coverage'].includes(entry.name)) {
              processDirectory(fullPath, depth + 1);
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

    processDirectory(dirPath);

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

    const processDirectory = (currentDir, depth = 0) => {
      if (depth > 5 || filesProcessed >= maxFiles) return;

      try {
        const entries = readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          if (filesProcessed >= maxFiles) break;

          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory() && recursive) {
            // Skip common ignore directories
            if (!['node_modules', '.git', '.vscode', '.idea', 'dist', 'build', 'coverage'].includes(entry.name)) {
              processDirectory(fullPath, depth + 1);
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

    processDirectory(dirPath);

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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'ASTSearch',
        description: 'Search for AST patterns in files or directories. Supports complex structural patterns with metavariables like $VAR, $FUNC, $$$',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to file or directory to search (absolute or relative to working directory)'
            },
            pattern: {
              type: 'string',
              description: 'AST pattern: $VAR (variable), $FUNC (function), $$$ (any code). Examples: "useState($INIT)", "function $F($P)", "$F has debugger", "kind: function_declaration"'
            },
            language: {
              type: 'string',
              enum: ['javascript', 'typescript', 'jsx', 'tsx', 'python', 'go', 'rust', 'c', 'cpp'],
              description: 'Language to use for parsing (auto-detected if not specified)'
            },
            recursive: {
              type: 'boolean',
              default: true,
              description: 'Search recursively in directories'
            },
            maxFiles: {
              type: 'number',
              default: 100,
              description: 'Maximum number of files to process'
            },
            maxMatches: {
              type: 'number',
              default: 50,
              description: 'Maximum matches per file'
            },
            includeContext: {
              type: 'boolean',
              default: false,
              description: 'Include surrounding lines in results'
            }
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
            path: {
              type: 'string',
              description: 'Path to file or directory to modify (absolute or relative to working directory)'
            },
            pattern: {
              type: 'string',
              description: 'AST pattern to find and replace. Examples: "var $NAME", "console.log($$$)", "debugger"'
            },
            replacement: {
              type: 'string',
              description: 'Replacement text for the AST pattern'
            },
            language: {
              type: 'string',
              enum: ['javascript', 'typescript', 'jsx', 'tsx', 'python', 'go', 'rust', 'c', 'cpp'],
              description: 'Language to use for parsing (auto-detected if not specified)'
            },
            recursive: {
              type: 'boolean',
              default: true,
              description: 'Apply recursively in directories'
            },
            maxFiles: {
              type: 'number',
              default: 50,
              description: 'Maximum number of files to process'
            },
            dryRun: {
              type: 'boolean',
              default: false,
              description: 'Show what would be changed without actually modifying files'
            }
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
            path: {
              type: 'string',
              description: 'Path to file or directory to modify'
            },
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
            language: {
              type: 'string',
              enum: ['javascript', 'typescript', 'jsx', 'tsx', 'python', 'go', 'rust', 'c', 'cpp'],
              description: 'Language to use for parsing'
            },
            dryRun: {
              type: 'boolean',
              default: false,
              description: 'Show what would be changed without actually modifying files'
            },
            recursive: {
              type: 'boolean',
              default: true,
              description: 'Apply recursively in directories'
            },
            maxFiles: {
              type: 'number',
              default: 50,
              description: 'Maximum number of files to process'
            }
          },
          required: ['path', 'transformations']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const helper = new ASTModificationHelper();

    if (name === 'ASTSearch') {
      const { path, pattern, language, recursive = true, maxFiles = 100, maxMatches = 50, includeContext = false } = args;

      const resolvedPath = path.startsWith('/') ? path : path.resolve(process.cwd(), path);

      if (!existsSync(resolvedPath)) {
        return {
          content: [{
            type: "text",
            text: `Error: Path not found: ${resolvedPath}`
          }],
          isError: true
        };
      }

      let result;
      if (statSync(resolvedPath).isDirectory()) {
        result = await helper.searchPatternInDirectory(resolvedPath, pattern, {
          recursive,
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.py', '.go', '.rs', '.c', '.cpp'],
          maxFiles,
          maxMatchesPerFile: maxMatches,
          language,
          includeContext
        });
      } else {
        result = await helper.searchPatternInFile(resolvedPath, pattern, {
          language,
          maxMatches,
          includeContext
        });
      }

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: `Error: ${result.error}`
          }],
          isError: true
        };
      }

      const insights = helper.generateASTInsights(result.results, 'search', pattern);

      let output = `🔍 AST Search Results:\n`;
      output += `📁 Path: ${resolvedPath}\n`;
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

      return {
        content: [{
          type: "text",
          text: output.trim()
        }]
      };

    } else if (name === 'ASTReplace') {
      const { path, pattern, replacement, language, recursive = true, maxFiles = 50, dryRun = false } = args;

      const resolvedPath = path.startsWith('/') ? path : path.resolve(process.cwd(), path);

      if (!existsSync(resolvedPath)) {
        return {
          content: [{
            type: "text",
            text: `Error: Path not found: ${resolvedPath}`
          }],
          isError: true
        };
      }

      let result;
      if (statSync(resolvedPath).isDirectory()) {
        result = await helper.replacePatternInDirectory(resolvedPath, pattern, replacement, {
          recursive,
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
          maxFiles,
          language,
          dryRun
        });
      } else {
        result = await helper.replacePatternInFile(resolvedPath, pattern, replacement, {
          language,
          dryRun
        });
      }

      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: `Error: ${result.error}`
          }],
          isError: true
        };
      }

      const insights = helper.generateASTInsights(result.results || [result], 'replace', pattern, replacement);

      let output = `🔄 AST Replacement Results:\n`;
      output += `📁 Path: ${resolvedPath}\n`;
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

      return {
        content: [{
          type: "text",
          text: output.trim()
        }]
      };

    } else if (name === 'ASTModify') {
      const { path, transformations, language, dryRun = false, recursive = true, maxFiles = 50 } = args;

      const resolvedPath = path.startsWith('/') ? path : path.resolve(process.cwd(), path);

      if (!existsSync(resolvedPath)) {
        return {
          content: [{
            type: "text",
            text: `Error: Path not found: ${resolvedPath}`
          }],
          isError: true
        };
      }

      let totalChanges = 0;
      let totalFilesModified = 0;
      let allResults = [];

      let output = `🔧 AST Modification Results:\n`;
      output += `📁 Path: ${resolvedPath}\n`;
      output += `🔍 Transformations: ${transformations.length}\n`;
      output += `${dryRun ? '🔍 DRY RUN - No files modified' : '✅ Files Modified'}\n\n`;

      for (let i = 0; i < transformations.length; i++) {
        const { pattern, replacement, description } = transformations[i];

        output += `Transformation ${i + 1}: ${description || pattern}\n`;
        output += `Pattern: "${pattern}" → "${replacement}"\n`;

        let result;
        if (statSync(resolvedPath).isDirectory()) {
          result = await helper.replacePatternInDirectory(resolvedPath, pattern, replacement, {
            recursive,
            extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
            maxFiles,
            language,
            dryRun
          });
        } else {
          result = await helper.replacePatternInFile(resolvedPath, pattern, replacement, {
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

      return {
        content: [{
          type: "text",
          text: output.trim()
        }]
      };

    } else {
      return {
        content: [{
          type: "text",
          text: `Error: Unknown tool ${name}`
        }],
        isError: true
      };
    }

  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
});

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    process.stderr.write(`AST Modification Server: Fatal error: ${error}\n${error.stack}\n`);
    throw error;
  }
}

main();