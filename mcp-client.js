#!/usr/bin/env node

// Simple MCP client that can be called from any execution context
// Usage: node mcp-client.js <server-name> <method> [args...]
// Example: node mcp-client.js filesystem tools/list
// Example: node mcp-client.js filesystem tools/call '{"name":"Read","arguments":{"file_path":"test.txt"}}'

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load MCP server configuration
function loadConfig() {
  const paths = [
    join(__dirname, '.codemode.json'),
    join(process.env.HOME || process.env.USERPROFILE || '~', '.claude', '.codemode.json')
  ];

  for (const configPath of paths) {
    try {
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf8'));
      }
    } catch (error) {
      // ignore
    }
  }

  return { mcpServers: {} };
}

const config = loadConfig();

class MCPClient {
  constructor(serverName, serverConfig) {
    this.serverName = serverName;
    this.serverConfig = serverConfig;
    this.requestId = 0;
    this.pendingRequests = new Map();
  }

  async start() {
    return new Promise((resolve, reject) => {
      console.error(`[MCP Client] Starting server: ${this.serverName}`);

      this.process = spawn(this.serverConfig.command, this.serverConfig.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: __dirname
      });

      let buffer = '';

      this.process.stderr.on('data', (data) => {
        console.error(`[${this.serverName}] ${data.toString().trim()}`);
      });

      this.process.stdout.on('data', (data) => {
        buffer += data.toString();
        let lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              this.handleResponse(response);
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      });

      this.process.on('error', (error) => {
        console.error(`[${this.serverName}] Error: ${error.message}`);
        reject(error);
      });

      this.process.on('close', () => {
        console.error(`[${this.serverName}] Closed`);
      });

      // Wait a bit for server to start
      setTimeout(() => {
        resolve();
      }, 1000);
    });
  }

  handleResponse(response) {
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      this.pendingRequests.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response);
      }
    }
  }

  async request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async close() {
    if (this.process) {
      this.process.kill();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node mcp-client.js <server-name> <method> [args...]');
    console.error('Examples:');
    console.error('  node mcp-client.js filesystem tools/list');
    console.error('  node mcp-client.js filesystem tools/call \'{"name":"Read","arguments":{"file_path":"test.txt"}}\'');
    process.exit(1);
  }

  const [serverName, method, ...argParts] = args;
  const serverConfig = config.mcpServers[serverName];

  if (!serverConfig) {
    console.error(`Server not found: ${serverName}`);
    console.error('Available servers:', Object.keys(config.mcpServers).join(', '));
    process.exit(1);
  }

  const client = new MCPClient(serverName, serverConfig);

  try {
    await client.start();

    // Parse arguments
    let params = {};
    if (method === 'tools/call' && argParts.length > 0) {
      params = JSON.parse(argParts.join(' '));
    }

    // Send request
    const response = await client.request(method, params);
    console.log(JSON.stringify(response, null, 2));

    await client.close();
  } catch (error) {
    console.error('Error:', error.message);
    await client.close();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { MCPClient, loadConfig };