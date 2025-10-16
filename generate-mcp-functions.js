#!/usr/bin/env node

// Generate MCP function definitions for the execute context
// This reads .codemode.json and generates JavaScript functions that can be called from within execute

import { MCPClient } from './mcp-client.js';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Cache for generated functions
let cachedFunctions = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 60000; // 1 minute cache

async function generateMCPFunctions(excludeServer = null) {
  const now = Date.now();

  // Return cached result if still valid
  if (cachedFunctions && (now - cacheTimestamp) < CACHE_DURATION) {
    console.error('Using cached MCP functions');
    return cachedFunctions;
  }

  console.error('Generating fresh MCP functions...');
  const config = loadConfig();
  let allFunctions = [];
  let functionDefinitions = '';
  let descriptionText = '';
  const usedFunctionNames = new Set();

  // Use Promise.all to start all servers in parallel (excluding specified server)
  const serverPromises = Object.entries(config.mcpServers)
    .filter(([serverName]) => serverName !== excludeServer)
    .map(async ([serverName, serverConfig]) => {
    console.error(`Generating functions for server: ${serverName}`);

    const client = new MCPClient(serverName, serverConfig);
    await client.start();

    try {
      const response = await client.request('tools/list');
      const tools = response.result?.tools || [];

      const serverFunctions = [];
      for (const tool of tools) {
        // Handle naming conflicts by adding server prefix if needed
        let functionName = tool.name;
        if (usedFunctionNames.has(functionName)) {
          functionName = `${serverName}_${tool.name}`;
        }
        usedFunctionNames.add(functionName);

        // Generate JavaScript function
        const jsFunction = generateJSFunction(functionName, tool, serverName, serverConfig);
        serverFunctions.push(jsFunction);

        // Add to description text
        descriptionText += `- **${functionName}**: ${tool.description}\n`;

        if (tool.inputSchema.properties) {
          descriptionText += `  Parameters: ${Object.keys(tool.inputSchema.properties).join(', ')}\n`;
        }
        descriptionText += '\n';
      }

      await client.close();
      return serverFunctions;
    } catch (error) {
      console.error(`Failed to get tools from ${serverName}:`, error.message);
      await client.close();
      return [];
    }
  });

  // Wait for all servers to complete
  const serverFunctionLists = await Promise.all(serverPromises);
  allFunctions = serverFunctionLists.flat();

  // Combine all functions
  functionDefinitions = allFunctions.join('\n\n');

  const result = {
    functions: functionDefinitions,
    description: descriptionText,
    count: allFunctions.length
  };

  // Cache the result
  cachedFunctions = result;
  cacheTimestamp = now;

  return result;
}

function generateJSFunction(functionName, tool, serverName, serverConfig) {
  const params = tool.inputSchema.properties || {};
  const requiredParams = tool.inputSchema.required || [];

  // Generate function signature
  const paramNames = Object.keys(params);
  const signature = `async function ${functionName}(${paramNames.map(p => {
    const isRequired = requiredParams.includes(p);
    return isRequired ? p : `${p} = null`;
  }).join(', ')})`;

  // Generate parameter validation
  let validationCode = '';
  if (requiredParams.length > 0) {
    validationCode = requiredParams.map(param =>
      `  if (${param} === null) throw new Error('Missing required parameter: ${param}');`
    ).join('\n');
  }

  // Generate arguments object
  const argsObject = paramNames.map(p => `${p}: ${p}`).join(', ');

  // Generate function body
  const functionBody = `${signature} {
${validationCode ? validationCode + '\n' : ''}  const args = { ${argsObject} };

  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('node', ['mcp-client.js', '${serverName}', 'tools/call', JSON.stringify({
      name: '${tool.name}',
      arguments: args
    })], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: __dirname
    });

    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errorOutput || 'Process failed'));
        return;
      }

      try {
        const response = JSON.parse(output);
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      } catch (e) {
        reject(new Error('Invalid JSON response: ' + output));
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}`;

  return functionBody;
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node generate-mcp-functions.js [--format js|desc]');
    console.log('  --format js     Output JavaScript function definitions');
    console.log('  --format desc   Output description text');
    console.log('  --format both   Output both (default)');
    process.exit(0);
  }

  const format = args.find(arg => arg.startsWith('--format='))?.split('=')[1] || 'both';

  try {
    const { functions, description, count } = await generateMCPFunctions();

    if (format === 'js' || format === 'both') {
      console.log('// Generated MCP Functions for Execute Context');
      console.log(`// ${count} functions available\n`);
      console.log(functions);
    }

    if (format === 'desc' || format === 'both') {
      if (format === 'both') {
        console.log('\n\n/*');
      }
      console.log('Available MCP Functions:');
      console.log('========================');
      console.log(description);
      if (format === 'both') {
        console.log('*/');
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { generateMCPFunctions };