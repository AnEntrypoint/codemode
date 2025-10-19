#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import ASTLinter, { LINTING_RULES, isAstGrepAvailable } from './ast-grep-wrapper.js';

const server = new Server(
  {
    name: 'ast-lint-server',
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
        name: 'ast_lint',
        description: 'Universal AST-based linting tool that works across all codebases. Runs on JavaScript, TypeScript, JSX, TSX, and supports universal code quality patterns. Only reports issues when they exist, with no false positives.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to file or directory to lint (absolute or relative to working directory)'
            },
            workingDirectory: {
              type: 'string',
              description: 'Absolute path to working directory for resolving relative paths'
            },
            recursive: {
              type: 'boolean',
              default: true,
              description: 'Whether to lint directories recursively'
            },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description: 'File extensions to lint (default: .js, .jsx, .ts, .tsx, .mjs)'
            },
            maxFiles: {
              type: 'number',
              default: 100,
              description: 'Maximum number of files to process'
            },
            groupBy: {
              type: 'string',
              enum: ['severity', 'file'],
              default: 'severity',
              description: 'How to group the linting results'
            },
            includePattern: {
              type: 'boolean',
              default: false,
              description: 'Include pattern information in output'
            }
          },
          required: ['path']
        }
      },
      {
        name: 'ast_lint_available',
        description: 'Check if AST linting functionality is available on this system',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'ast_lint_available') {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          available: isAstGrepAvailable(),
          message: isAstGrepAvailable() ?
            'AST linting is available on this system' :
            'AST linting is not available - @ast-grep/napi native binding failed to load'
        }, null, 2)
      }]
    };
  }

  if (name === 'ast_lint') {
    try {
      const path = args.path;
      const workingDirectory = args.workingDirectory || process.cwd();

      // Resolve path relative to working directory if not absolute
      const fs = await import('fs');
      const pathModule = await import('path');

      const targetPath = pathModule.isAbsolute(path) ?
        path : pathModule.resolve(workingDirectory, path);

      if (!fs.existsSync(targetPath)) {
        return {
          content: [{
            type: "text",
            text: `Error: Path not found: ${targetPath}`
          }],
          isError: true
        };
      }

      const linter = new ASTLinter(workingDirectory);

      let result;
      const options = {
        recursive: args.recursive !== false,
        extensions: args.extensions || ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
        maxFiles: args.maxFiles || 100
      };

      if (fs.statSync(targetPath).isDirectory()) {
        result = await linter.lintDirectory(targetPath, options);
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
        return {
          content: [{
            type: "text",
            text: 'AST linting is not available on this system. The @ast-grep/napi native binding could not be loaded.'
          }],
          isError: true
        };
      }

      // Only report when there are issues
      if (result.totalIssues === 0) {
        return {
          content: [{
            type: "text",
            text: '✅ No linting issues found'
          }]
        };
      }

      const formattedOutput = linter.formatIssues(result.issues, {
        groupBy: args.groupBy || 'severity',
        includePattern: args.includePattern || false
      });

      const summary = `🔍 Linting Results:
📁 Path: ${targetPath}
📄 Files scanned: ${result.files.length}
🚨 Errors: ${result.errors}
⚠️  Warnings: ${result.warnings}
ℹ️  Info: ${result.info}
📊 Total issues: ${result.totalIssues}

`;

      return {
        content: [{
          type: "text",
          text: summary + formattedOutput
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error during AST linting: ${error.message}`
        }],
        isError: true
      };
    }
  }

  return {
    content: [{
      type: "text",
      text: `Unknown tool: ${name}`
    }],
    isError: true
  };
});

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    process.stderr.write(`AST Lint MCP Server: Fatal error: ${error}\n${error.stack}\n`);
    throw error;
  }
}

main();