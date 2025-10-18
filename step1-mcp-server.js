#!/usr/bin/env node

console.error('[DEBUG] Step 1 MCP server starting...');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import fg from 'fast-glob';
import { Readability } from '@mozilla/readability';
// import { JSDOM } from 'jsdom';
import fetch from 'node-fetch';

console.error('[DEBUG] All imports from built-in-tools-mcp.js loaded');

console.error('[DEBUG] Imports successful');

const server = new Server(
  {
    name: 'minimal-test-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

console.error('[DEBUG] Server created');

server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error('[DEBUG] ListTools called');
  return {
    tools: [
      {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          },
          required: ['message']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.error('[DEBUG] CallTool called:', JSON.stringify(request));
  const { name, arguments: args } = request.params;
  if (name === 'test') {
    return { content: [{ type: 'text', text: `Echo: ${args.message}` }] };
  }
  throw new Error(`Unknown tool: ${name}`);
});

console.error('[DEBUG] Request handlers set up');

async function main() {
  console.error('[DEBUG] Main function starting...');
  const transport = new StdioServerTransport();
  console.error('[DEBUG] Transport created, connecting...');
  await server.connect(transport);
  console.error('[DEBUG] Server connected and running');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
