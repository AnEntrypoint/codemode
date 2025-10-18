#!/usr/bin/env node

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadConfig() {
  const noMcp = process.argv.includes('--nomcp');
  if (noMcp) {
    console.error('[Execute Server] --nomcp flag detected, MCP tools disabled');
    return { mcpServers: {} };
  }

  const paths = [
    join(process.cwd(), '.codemode.json'),
    join(__dirname, '.codemode.json'),
    join(process.env.HOME || process.env.USERPROFILE || '~', '.claude', '.codemode.json')
  ];

  for (const configPath of paths) {
    try {
      if (existsSync(configPath)) {
        console.error(`[Execute Server] Loading config from: ${configPath}`);
        return JSON.parse(readFileSync(configPath, 'utf8'));
      }
    } catch (error) {
      console.error(`[Execute Server] Failed to load config from ${configPath}:`, error.message);
    }
  }

  console.error('[Execute Server] No config found, using empty config');
  return { mcpServers: {} };
}

// Simplified MCP Server Manager to debug the issue
class DebugMCPManager {
  async initialize(config) {
    console.error('[Debug MCP Manager] Initializing...');

    // Start just the built-in tools server
    const serverConfig = config.mcpServers?.builtInTools;
    if (!serverConfig) {
      console.error('[Debug MCP Manager] No builtInTools server found in config');
      return;
    }

    console.error('[Debug MCP Manager] Starting builtInTools...');
    await this.startServer('builtInTools', serverConfig);
  }

  async startServer(serverName, serverConfig) {
    console.error(`[Debug MCP Manager] Starting ${serverName}...`);

    const proc = spawn(serverConfig.command, serverConfig.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: __dirname
    });

    let buffer = '';
    let initialized = false;

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            console.error(`[Debug MCP Manager] Received:`, JSON.stringify(response, null, 2));

            if (!initialized && response.method === 'initialize') {
              // Send initialize response
              proc.stdin.write(JSON.stringify({
                jsonrpc: '2.0',
                id: response.id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: {},
                  serverInfo: { name: 'debug-manager', version: '1.0.0' }
                }
              }) + '\n');

              // Request tools list
              proc.stdin.write(JSON.stringify({
                jsonrpc: '2.0',
                id: 999,
                method: 'tools/list'
              }) + '\n');
            } else if (response.id === 999 && response.result) {
              console.error('[Debug MCP Manager] Tools received:');
              const tools = response.result.tools || [];
              tools.forEach(tool => {
                console.error(`- ${tool.name}: ${tool.description}`);
                console.error(`  Required: ${JSON.stringify(tool.inputSchema?.required || [])}`);
                console.error(`  Properties: ${JSON.stringify(Object.keys(tool.inputSchema?.properties || {}))}`);
              });

              // Generate the function for Write tool
              const writeTool = tools.find(t => t.name === 'Write');
              if (writeTool) {
                console.error('\n[Debug MCP Manager] === Generating Write Function ===');
                const params = writeTool.inputSchema?.properties || {};
                const required = writeTool.inputSchema?.required || [];
                const paramNames = Object.keys(params);

                console.error(`Parameters: ${paramNames.join(', ')}`);
                console.error(`Required: ${required.join(', ')}`);

                const reservedWords = ['function', 'class', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while'];
                const safeParamNames = paramNames.map(p => reservedWords.includes(p) ? `_${p}` : p);

                const signature = `async function Write(${safeParamNames.map((p, i) => {
                  const isRequired = required.includes(paramNames[i]);
                  return isRequired ? p : `${p} = null`;
                }).join(', ')})`;

                console.error(`Signature: ${signature}`);

                let validation = '';
                if (required.length > 0) {
                  validation = required.map(p => {
                    const idx = paramNames.indexOf(p);
                    const safeName = safeParamNames[idx];
                    return `  if (${safeName} === null || ${safeName} === undefined) throw new Error('Missing required parameter: ${p}');`;
                  }).join('\n');
                }

                console.error(`Validation:\n${validation}`);

                // Generate the actual function
                const generatedFunction = `
global.builtInTools.Write = ${signature} {
${validation ? validation + '\n' : ''}  // Flexible parameter handling for various LLM coding styles
  let args = {};

  // Debug: Log received parameters
  console.error('[DEBUG] Write called with params:', [${safeParamNames.join(', ')}].map(p => typeof p === 'object' ? JSON.stringify(p) : p));

  // Handle different calling patterns that LLMs might generate:
  if (paramNames.length > 0 && typeof ${safeParamNames[0]} === 'object' && ${safeParamNames[0]} !== null && !Array.isArray(${safeParamNames[0]})) {
    // Object-style call: Write({file_path: '...', content: '...'})
    args = ${safeParamNames[0]};
    console.error('[DEBUG] Using object-style args:', JSON.stringify(args));
  } else {
    // Individual params call: Write('file.txt', 'content')
    // Also handle missing/undefined parameters gracefully
${paramNames.map((p, i) => `    if (${safeParamNames[i]} !== null && ${safeParamNames[i]} !== undefined) args.${p} = ${safeParamNames[i]};`).join('\n')}
    console.error('[DEBUG] Using individual params args:', JSON.stringify(args));
  }

  // Common parameter name variations for LLM flexibility
  const paramMappings = {
    'file_path': ['filePath', 'filename', 'path', 'file'],
    'content': ['text', 'data', 'body'],
    'old_string': ['oldString', 'oldText', 'find'],
    'new_string': ['newString', 'newText', 'replace'],
    'file': ['file_path', 'filePath'],
    'text': ['content', 'data'],
    'command': ['cmd'],
    'description': ['desc'],
    'url': ['uri', 'link']
  };

  // Apply parameter name mappings for flexibility
  for (const [canonical, alternatives] of Object.entries(paramMappings)) {
    if (!args[canonical]) {
      for (const alt of alternatives) {
        if (args[alt] !== undefined) {
          args[canonical] = args[alt];
          break;
        }
      }
    }
  }
  return await global.__callMCPTool('builtInTools', 'Write', args);
};`;

                console.error('\n[Debug MCP Manager] Generated function:');
                console.error(generatedFunction);
              }

              proc.kill();
              process.exit(0);
            }
          } catch (e) {
            console.error('[Debug MCP Manager] JSON parse error:', e.message);
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      console.error(`[Debug MCP Manager] ${serverName} stderr:`, data.toString().trim());
    });

    // Send initialize request
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'debug-manager', version: '1.0.0' }
      }
    }) + '\n');
  }
}

async function main() {
  const config = loadConfig();
  const manager = new DebugMCPManager();
  await manager.initialize(config);
}

main().catch(console.error);