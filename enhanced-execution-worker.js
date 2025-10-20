#!/usr/bin/env node

// Enhanced execution context worker with comprehensive robustness features
// Communicates with parent via IPC for MCP tool calls

import { createRequire } from 'module';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

// Initialize global scope for user code
global.require = null;
global.__filename = null;
global.__dirname = null;
global.module = { exports: {} };
global.exports = global.module.exports;

// Enhanced validation and monitoring systems
class FileContentValidator {
  static validateWrite(filePath, content) {
    const validation = {
      isValid: true,
      warnings: [],
      errors: []
    };

    try {
      // Check for valid file path
      if (!filePath || typeof filePath !== 'string') {
        validation.isValid = false;
        validation.errors.push('Invalid file path');
        return validation;
      }

      // Check content type consistency
      if (typeof content !== 'string') {
        validation.isValid = false;
        validation.errors.push('Content must be a string');
        return validation;
      }

      // File extension validation
      const ext = filePath.split('.').pop().toLowerCase();
      const contentTrimmed = content.trim();

      if (ext === 'js' || ext === 'mjs' || ext === 'ts') {
        // Basic JavaScript syntax validation
        try {
          new Function(contentTrimmed);
        } catch (syntaxError) {
          validation.warnings.push(`Potential syntax issue: ${syntaxError.message}`);
        }

        // Check for common patterns
        if (contentTrimmed.includes('require(') && (ext === 'mjs' || contentTrimmed.includes('import'))) {
          validation.warnings.push('Mixed CommonJS and ES modules detected');
        }

        // Check for potentially dangerous code
        const dangerousPatterns = [
          /eval\s*\(/,
          /Function\s*\(/,
          /process\.exit/,
          /child_process/,
          /fs\.unlinkSync/,
          /rm\s+-rf/
        ];

        dangerousPatterns.forEach(pattern => {
          if (pattern.test(contentTrimmed)) {
            validation.warnings.push(`Potentially dangerous pattern detected: ${pattern.source}`);
          }
        });
      }

      if (ext === 'json') {
        try {
          JSON.parse(contentTrimmed);
        } catch (jsonError) {
          validation.isValid = false;
          validation.errors.push(`Invalid JSON: ${jsonError.message}`);
        }
      }

      // Check for empty content
      if (contentTrimmed.length === 0) {
        validation.warnings.push('Writing empty file');
      }

    } catch (error) {
      validation.isValid = false;
      validation.errors.push(`Validation error: ${error.message}`);
    }

    return validation;
  }
}

class SyntaxValidator {
  static validateJavaScript(code) {
    const result = {
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: []
    };

    try {
      // Basic syntax check
      new Function(code);

      // More detailed analysis
      const lines = code.split('\n');

      // Check for common issues
      lines.forEach((line, index) => {
        const lineNum = index + 1;
        const trimmed = line.trim();

        // Check for missing semicolons (optional)
        if (trimmed && !trimmed.endsWith(';') && !trimmed.endsWith('{') && !trimmed.endsWith('}') &&
            !trimmed.includes('if ') && !trimmed.includes('for ') && !trimmed.includes('while ') &&
            !trimmed.includes('function ') && !trimmed.includes('class ') && !trimmed.includes('=>')) {
          result.suggestions.push(`Line ${lineNum}: Consider adding semicolon`);
        }

        // Check for console.log statements
        if (trimmed.includes('console.log')) {
          result.warnings.push(`Line ${lineNum}: Console.log statement detected`);
        }

        // Check for TODO/FIXME comments
        if (trimmed.includes('// TODO') || trimmed.includes('// FIXME')) {
          result.warnings.push(`Line ${lineNum}: TODO/FIXME comment found`);
        }
      });

      // Check for proper async/await usage
      if (code.includes('await') && !code.includes('async')) {
        result.warnings.push('Await found without async function');
      }

      // Check for proper error handling
      if (code.includes('try') && !code.includes('catch')) {
        result.warnings.push('Try block without catch block');
      }

    } catch (error) {
      result.isValid = false;
      result.errors.push(`Syntax error: ${error.message}`);
    }

    return result;
  }
}

class BuildValidator {
  constructor() {
    this.buildSteps = [];
    this.rollbackStack = [];
  }

  addBuildStep(description, action, rollback) {
    this.buildSteps.push({ description, action, rollback });
  }

  async executeBuild() {
    const results = {
      success: true,
      executedSteps: [],
      failedStep: null,
      error: null
    };

    for (let i = 0; i < this.buildSteps.length; i++) {
      const step = this.buildSteps[i];

      try {
        console.log(`[Build] Executing step: ${step.description}`);
        const stepResult = await step.action();
        this.rollbackStack.push(step.rollback);
        results.executedSteps.push({
          step: step.description,
          result: stepResult,
          success: true
        });
      } catch (error) {
        results.success = false;
        results.failedStep = step.description;
        results.error = error.message;

        console.error(`[Build] Step failed: ${step.description} - ${error.message}`);

        // Rollback all successful steps
        await this.rollback();
        break;
      }
    }

    return results;
  }

  async rollback() {
    console.log('[Build] Rolling back failed build...');

    for (let i = this.rollbackStack.length - 1; i >= 0; i--) {
      const rollback = this.rollbackStack[i];
      try {
        await rollback();
      } catch (rollbackError) {
        console.error(`[Build] Rollback failed: ${rollbackError.message}`);
      }
    }

    this.rollbackStack = [];
  }
}

class ProcessHealthMonitor {
  constructor() {
    this.processes = new Map();
    this.retries = new Map();
    this.maxRetries = 3;
    this.healthCheckInterval = 5000; // 5 seconds
    this.monitorInterval = null;
  }

  startMonitoring() {
    this.monitorInterval = setInterval(() => {
      this.checkAllProcesses();
    }, this.healthCheckInterval);
  }

  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  registerProcess(processId, processInfo) {
    this.processes.set(processId, {
      ...processInfo,
      startTime: Date.now(),
      lastHealthCheck: Date.now(),
      status: 'running',
      healthChecks: 0
    });

    if (!this.monitorInterval) {
      this.startMonitoring();
    }
  }

  async checkProcess(processId) {
    const process = this.processes.get(processId);
    if (!process) return false;

    try {
      // Health check logic based on process type
      let isHealthy = false;

      if (process.type === 'mcp_server') {
        // Check if MCP server is responsive
        isHealthy = await this.checkMCPServer(process);
      } else if (process.type === 'execution_worker') {
        // Check if execution worker is responsive
        isHealthy = await this.checkExecutionWorker(process);
      }

      process.lastHealthCheck = Date.now();
      process.healthChecks++;

      if (!isHealthy && process.status === 'running') {
        console.warn(`[Health Monitor] Process ${processId} appears unhealthy`);
        return await this.handleUnhealthyProcess(processId);
      }

      return isHealthy;
    } catch (error) {
      console.error(`[Health Monitor] Error checking process ${processId}:`, error.message);
      return false;
    }
  }

  async checkMCPServer(process) {
    // Simple health check - try to ping the server
    return process.pid && !process.killed;
  }

  async checkExecutionWorker(process) {
    // Check if worker is still connected
    return process.connected && !process.killed;
  }

  async handleUnhealthyProcess(processId) {
    const process = this.processes.get(processId);
    if (!process) return false;

    const retryCount = this.retries.get(processId) || 0;

    if (retryCount < this.maxRetries) {
      console.log(`[Health Monitor] Attempting to restart process ${processId} (retry ${retryCount + 1}/${this.maxRetries})`);

      this.retries.set(processId, retryCount + 1);

      try {
        // Attempt to restart the process
        if (process.restart) {
          await process.restart();
          console.log(`[Health Monitor] Successfully restarted process ${processId}`);
          return true;
        }
      } catch (error) {
        console.error(`[Health Monitor] Failed to restart process ${processId}:`, error.message);
      }
    } else {
      console.error(`[Health Monitor] Max retries exceeded for process ${processId}`);
      process.status = 'failed';
      return false;
    }

    return false;
  }

  async checkAllProcesses() {
    for (const [processId] of this.processes) {
      await this.checkProcess(processId);
    }
  }

  getProcessHealth() {
    const health = {};
    for (const [processId, process] of this.processes) {
      health[processId] = {
        status: process.status,
        startTime: process.startTime,
        lastHealthCheck: process.lastHealthCheck,
        healthChecks: process.healthChecks,
        retryCount: this.retries.get(processId) || 0
      };
    }
    return health;
  }
}

class ToolAvailabilityChecker {
  constructor() {
    this.tools = new Map();
  }

  registerTool(toolName, toolFunction) {
    this.tools.set(toolName, {
      func: toolFunction,
      available: true,
      lastCheck: Date.now(),
      errorCount: 0
    });
  }

  async checkTool(toolName) {
    const tool = this.tools.get(toolName);
    if (!tool) return false;

    try {
      // Simple availability check
      if (typeof tool.func === 'function') {
        tool.available = true;
        tool.lastCheck = Date.now();
        tool.errorCount = 0;
        return true;
      }
    } catch (error) {
      tool.errorCount++;
      tool.lastCheck = Date.now();

      if (tool.errorCount > 3) {
        tool.available = false;
        console.warn(`[Tool Checker] Tool ${toolName} marked as unavailable after ${tool.errorCount} errors`);
      }
    }

    return tool.available;
  }

  async executeTool(toolName, ...args) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`BRUTAL ERROR: Tool ${toolName} not registered - no fallbacks available`);
    }

    // Check if tool is available
    const isAvailable = await this.checkTool(toolName);

    if (!isAvailable) {
      throw new Error(`BRUTAL ERROR: Tool ${toolName} is not available - error count: ${tool.errorCount}, last check: ${new Date(tool.lastCheck).toISOString()} - NO FALLBACKS EXIST`);
    }

    try {
      const result = await tool.func(...args);
      return result;
    } catch (error) {
      tool.errorCount++;
      console.error(`BRUTAL ERROR: Tool ${toolName} execution failed #${tool.errorCount}:`, error.message);
      throw error;
    }
  }

  getToolStatus() {
    const status = {};
    for (const [toolName, tool] of this.tools) {
      status[toolName] = {
        available: tool.available,
        lastCheck: tool.lastCheck,
        errorCount: tool.errorCount
      };
    }
    return status;
  }
}

class OperationLogger {
  constructor() {
    this.operations = [];
    this.maxOperations = 1000;
  }

  log(operation, details, level = 'info') {
    const logEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      operation,
      details,
      level,
      state: this.captureState()
    };

    this.operations.push(logEntry);

    // Keep only the last maxOperations entries
    if (this.operations.length > this.maxOperations) {
      this.operations = this.operations.slice(-this.maxOperations);
    }

    console.log(`[Operation Logger] ${level.toUpperCase()}: ${operation} - ${JSON.stringify(details)}`);
  }

  captureState() {
    return {
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      pid: process.pid
    };
  }

  getOperations(filter = {}) {
    let filtered = this.operations;

    if (filter.operation) {
      filtered = filtered.filter(op => op.operation === filter.operation);
    }

    if (filter.level) {
      filtered = filtered.filter(op => op.level === filter.level);
    }

    if (filter.since) {
      const since = new Date(filter.since);
      filtered = filtered.filter(op => new Date(op.timestamp) >= since);
    }

    return filtered;
  }

  clear() {
    this.operations = [];
  }
}

// Initialize global monitoring systems
const healthMonitor = new ProcessHealthMonitor();
const toolChecker = new ToolAvailabilityChecker();
const operationLogger = new OperationLogger();

// ES module execution helper
class ESModuleExecutor {
  constructor() {
    this.tempDir = join(process.cwd(), '.temp-es-modules');
    this.ensureTempDir();
  }

  ensureTempDir() {
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async executeESModule(code, workingDirectory) {
    const moduleId = randomUUID();
    const tempFilePath = join(this.tempDir, `module-${moduleId}.mjs`);

    try {
      // Validate syntax before execution
      const validation = SyntaxValidator.validateJavaScript(code);
      if (!validation.isValid) {
        throw new Error(`Syntax validation failed: ${validation.errors.join(', ')}`);
      }

      // Log warnings if any
      if (validation.warnings.length > 0) {
        operationLogger.log('ES_MODULE_EXECUTION', {
          warnings: validation.warnings,
          suggestions: validation.suggestions
        }, 'warning');
      }

      // Prepare the ES module code with proper context
      const moduleCode = this.prepareModuleCode(code, workingDirectory, tempFilePath);

      // Write the temporary module file with validation
      const writeValidation = FileContentValidator.validateWrite(tempFilePath, moduleCode);
      if (!writeValidation.isValid) {
        throw new Error(`Failed to write temporary module: ${writeValidation.errors.join(', ')}`);
      }

      writeFileSync(tempFilePath, moduleCode, 'utf8');

      // Execute using dynamic import
      const moduleUrl = `file://${tempFilePath}`;
      const module = await import(moduleUrl);

      // Return the module's default export or the module itself
      return module.default || module;

    } finally {
      // Clean up temporary file
      try {
        unlinkSync(tempFilePath);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  }

  prepareModuleCode(code, workingDirectory, filePath) {
    // Prepare module with context variables
    let moduleCode = code;

    // Check if imports and variables are already present
    const hasFileURLToPathImport = code.includes('fileURLToPath') && code.includes('import');
    const hasDirnameImport = code.includes('dirname') && code.includes('import');
    const hasCreateRequireImport = code.includes('createRequire') && code.includes('import');

    const hasFilenameDecl = code.includes('__filename') && (code.includes('const __filename') || code.includes('let __filename') || code.includes('var __filename'));
    const hasDirnameDecl = code.includes('__dirname') && (code.includes('const __dirname') || code.includes('let __dirname') || code.includes('var __dirname'));
    const hasRequireDecl = code.includes('require = ') || code.includes('const require');

    // Build the import prefix only for missing imports
    let importPrefix = '';
    if (!hasCreateRequireImport) {
      importPrefix += `import { createRequire } from 'module';\n`;
    }
    if (!hasFileURLToPathImport) {
      importPrefix += `import { fileURLToPath } from 'url';\n`;
    }
    if (!hasDirnameImport) {
      importPrefix += `import { dirname } from 'path';\n`;
    }

    // Build the variable declarations only for missing ones
    let variableSetup = '';
    if (!hasFilenameDecl) {
      variableSetup += `const __filename = fileURLToPath(import.meta.url);\n`;
    }
    if (!hasDirnameDecl) {
      variableSetup += `const __dirname = dirname(__filename);\n`;
    }
    if (!hasRequireDecl) {
      variableSetup += `const require = createRequire(import.meta.url);\n`;
    }

    // Add the context setup if any imports or variables were added
    if (importPrefix || variableSetup) {
      moduleCode = importPrefix +
        (variableSetup ? '\n' + variableSetup : '') +
        `// Make require available globally for compatibility
if (!global.require) global.require = require;

` + moduleCode;
    }

    return moduleCode;
  }

  isESModule(code) {
    // Check if code contains ES module import/export syntax
    return /\bimport\s+.*\s+from\s+['"]|^\s*export\s+/.test(code);
  }
}

const esModuleExecutor = new ESModuleExecutor();

const pendingMCPCalls = new Map();
let nextCallId = 0;

// Persistent execution context - maintains state across all executions
const persistentContext = {};
const runningExecutions = new Map(); // Track running executions
const asyncExecutions = new Map(); // Track async executions after handover
const asyncHandoverTimeout = 30000; // 30 seconds default

// Capture console output
let capturedOutput = '';
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function startCapture(execId) {
  capturedOutput = '';

  console.log = (...args) => {
    const msg = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    capturedOutput += msg + '\n';

    // Store in execution history for async handover
    let execution = runningExecutions.get(execId);
    if (!execution) {
      execution = asyncExecutions.get(execId);
    }
    if (execution) {
      execution.outputHistory.push({
        timestamp: Date.now(),
        type: 'log',
        message: msg
      });
    }

    originalConsoleLog(...args);

    // Stream output in real-time
    if (execId !== undefined) {
      process.send({ type: 'STREAM_OUTPUT', execId, output: msg });
    }
  };

  console.error = (...args) => {
    const msg = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    capturedOutput += msg + '\n';

    // Store in execution history for async handover
    let execution = runningExecutions.get(execId);
    if (!execution) {
      execution = asyncExecutions.get(execId);
    }
    if (execution) {
      execution.outputHistory.push({
        timestamp: Date.now(),
        type: 'error',
        message: msg
      });
    }

    originalConsoleError(...args);

    // Stream output in real-time
    if (execId !== undefined) {
      process.send({ type: 'STREAM_OUTPUT', execId, output: msg });
    }
  };

  console.warn = (...args) => {
    const msg = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    capturedOutput += msg + '\n';

    // Store in execution history for async handover
    let execution = runningExecutions.get(execId);
    if (!execution) {
      execution = asyncExecutions.get(execId);
    }
    if (execution) {
      execution.outputHistory.push({
        timestamp: Date.now(),
        type: 'warn',
        message: msg
      });
    }

    originalConsoleWarn(...args);

    // Stream output in real-time
    if (execId !== undefined) {
      process.send({ type: 'STREAM_OUTPUT', execId, output: msg });
    }
  };
}

function stopCapture() {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  return capturedOutput;
}

function moveToAsyncMode(execId) {
  const execution = runningExecutions.get(execId);
  if (!execution) return;

  // Clear the handover timer
  if (execution.handoverTimer) {
    clearTimeout(execution.handoverTimer);
    execution.handoverTimer = null;
  }

  // Mark as async
  execution.isAsync = true;
  execution.asyncStartTime = Date.now();

  // Get current progress from output history
  const currentOutput = execution.outputHistory.map(entry =>
    `[${new Date(entry.timestamp).toISOString()}] ${entry.message}`
  ).join('\n');

  // Clear output history to save memory (as requested)
  execution.outputHistory = [];

  // Move to async executions
  runningExecutions.delete(execId);
  asyncExecutions.set(execId, execution);

  // Notify parent about handover with current progress
  process.send({
    type: 'ASYNC_HANDOVER',
    execId,
    executionInfo: {
      id: execId,
      code: execution.code,
      workingDirectory: execution.workingDirectory,
      startTime: execution.startTime,
      asyncStartTime: execution.asyncStartTime,
      currentOutput: currentOutput,
      isAsync: true
    }
  });

  console.log(`[Async Handover] Execution ${execId} moved to async mode, history cleared`);
}

// Enhanced error handler
class ErrorHandler {
  static async handleError(error, context = {}) {
    const errorInfo = {
      message: error.message,
      stack: error.stack,
      context,
      timestamp: new Date().toISOString(),
      suggestions: []
    };

    // Log the error
    operationLogger.log('ERROR', errorInfo, 'error');

    // Generate recovery suggestions based on error type
    if (error.message.includes('ENOENT')) {
      errorInfo.suggestions.push('Check if file paths are correct');
      errorInfo.suggestions.push('Ensure working directory is set properly');
    } else if (error.message.includes('EACCES')) {
      errorInfo.suggestions.push('Check file permissions');
      errorInfo.suggestions.push('Try running with appropriate permissions');
    } else if (error.message.includes('timeout')) {
      errorInfo.suggestions.push('Increase timeout value');
      errorInfo.suggestions.push('Check if process is hanging');
    } else if (error.message.includes('syntax')) {
      errorInfo.suggestions.push('Validate JavaScript syntax');
      errorInfo.suggestions.push('Check for missing brackets or semicolons');
    }

    return errorInfo;
  }
}

// Handle messages from parent
process.on('message', async (msg) => {
  if (msg.type === 'MCP_RESULT') {
    const { callId, success, result } = msg;
    if (pendingMCPCalls.has(callId)) {
      const { resolve, reject } = pendingMCPCalls.get(callId);
      pendingMCPCalls.delete(callId);

      if (success) {
        resolve(result);
      } else {
        reject(new Error(result));
      }
    }
  } else if (msg.type === 'HEALTH_CHECK') {
    // Respond to health check requests
    const health = {
      processes: healthMonitor.getProcessHealth(),
      tools: toolChecker.getToolStatus(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      runningExecutions: runningExecutions.size,
      asyncExecutions: asyncExecutions.size
    };

    process.send({ type: 'HEALTH_STATUS', health });
  } else if (msg.type === 'GET_OPERATION_LOG') {
    // Return operation log
    const operations = operationLogger.getOperations(msg.filter || {});
    process.send({ type: 'OPERATION_LOG', operations });
  } else if (msg.type === 'KILL_EXECUTION') {
    operationLogger.log('KILL_EXECUTION', { execId: msg.execId });
    // Original kill execution logic...
    const execId = msg.execId;
    let killed = false;
    let error = null;

    if (execId) {
      // Kill specific execution
      if (runningExecutions.has(execId)) {
        const execution = runningExecutions.get(execId);
        execution.killed = true;
        if (execution.handoverTimer) {
          clearTimeout(execution.handoverTimer);
        }
        runningExecutions.delete(execId);
        killed = true;
      } else if (asyncExecutions.has(execId)) {
        const execution = asyncExecutions.get(execId);
        execution.killed = true;
        asyncExecutions.delete(execId);
        killed = true;
      } else {
        error = 'Execution not found';
      }
    } else {
      // Kill all executions
      let count = 0;
      runningExecutions.forEach((execution, id) => {
        execution.killed = true;
        if (execution.handoverTimer) {
          clearTimeout(execution.handoverTimer);
        }
        runningExecutions.delete(id);
        count++;
      });
      asyncExecutions.forEach((execution, id) => {
        execution.killed = true;
        asyncExecutions.delete(id);
        count++;
      });
      killed = true;
    }

    process.send({ type: 'EXECUTION_KILLED', execId, success: killed, error, killedCount: execId ? null : Array.from(runningExecutions.keys()).length + Array.from(asyncExecutions.keys()).length });
  } else if (msg.type === 'GET_ASYNC_EXECUTION') {
    operationLogger.log('GET_ASYNC_EXECUTION', { execId: msg.execId });
    // Original get async execution logic...
    const execId = msg.execId;
    if (asyncExecutions.has(execId)) {
      const execution = asyncExecutions.get(execId);
      process.send({
        type: 'ASYNC_EXECUTION_DATA',
        execId,
        data: {
          id: execId,
          code: execution.code,
          workingDirectory: execution.workingDirectory,
          startTime: execution.startTime,
          asyncStartTime: execution.asyncStartTime,
          completionTime: execution.completionTime,
          outputHistory: execution.outputHistory,
          isKilled: execution.killed,
          completed: execution.completed,
          error: execution.error
        }
      });
    } else {
      process.send({
        type: 'ASYNC_EXECUTION_DATA',
        execId,
        error: 'Async execution not found'
      });
    }
  } else if (msg.type === 'LIST_ASYNC_EXECUTIONS') {
    operationLogger.log('LIST_ASYNC_EXECUTIONS');
    // Original list async executions logic...
    const asyncList = Array.from(asyncExecutions.entries()).map(([id, execution]) => ({
      id,
      workingDirectory: execution.workingDirectory,
      startTime: execution.startTime,
      asyncStartTime: execution.asyncStartTime,
      outputHistoryLength: execution.outputHistory.length,
      isKilled: execution.killed
    }));
    process.send({ type: 'ASYNC_EXECUTIONS_LIST', executions: asyncList });
  } else if (msg.type === 'GET_SERVER_STATE') {
    operationLogger.log('GET_SERVER_STATE');
    // Original get server state logic with enhanced monitoring
    const state = {
      runningExecutions: Array.from(runningExecutions.entries()).map(([id, info]) => ({
        id,
        startTime: info.startTime,
        code: info.code.substring(0, 100), // Truncate for security
        workingDirectory: info.workingDirectory,
        duration: Date.now() - info.startTime,
        isAsync: info.isAsync
      })),
      asyncExecutions: Array.from(asyncExecutions.entries()).map(([id, info]) => ({
        id,
        startTime: info.startTime,
        asyncStartTime: info.asyncStartTime,
        code: info.code.substring(0, 100), // Truncate for security
        workingDirectory: info.workingDirectory,
        duration: Date.now() - info.startTime,
        outputHistoryLength: info.outputHistory.length,
        isKilled: info.killed
      })),
      persistentContextSize: Object.keys(persistentContext).length,
      serverPersistent: true,
      asyncHandoverTimeout: asyncHandoverTimeout,
      health: healthMonitor.getProcessHealth(),
      tools: toolChecker.getToolStatus(),
      memory: process.memoryUsage(),
      uptime: process.uptime()
    };
    process.send({ type: 'SERVER_STATE', state });
  } else if (msg.type === 'CLEAR_ASYNC_HISTORY') {
    operationLogger.log('CLEAR_ASYNC_HISTORY', { execId: msg.execId });
    // Original clear async history logic...
    const execId = msg.execId;
    const clearHistory = msg.clearHistory;
    if (asyncExecutions.has(execId)) {
      const execution = asyncExecutions.get(execId);
      if (clearHistory) {
        execution.outputHistory = [];
      }
      process.send({
        type: 'ASYNC_HISTORY_CLEARED',
        execId,
        cleared: clearHistory,
        historyLength: execution.outputHistory.length
      });
    } else {
      process.send({
        type: 'ASYNC_HISTORY_CLEARED',
        execId,
        error: 'Async execution not found'
      });
    }
  } else if (msg.type === 'GET_ASYNC_PROGRESS') {
    operationLogger.log('GET_ASYNC_PROGRESS', { execId: msg.execId });
    // Original get async progress logic...
    const execId = msg.execId;
    const since = msg.since;
    if (asyncExecutions.has(execId)) {
      const execution = asyncExecutions.get(execId);
      let outputHistory = execution.outputHistory;

      // Filter by timestamp if 'since' is provided
      if (since) {
        const sinceTime = new Date(since).getTime();
        outputHistory = outputHistory.filter(entry => entry.timestamp > sinceTime);
      }

      const progressOutput = outputHistory.map(entry =>
        `[${new Date(entry.timestamp).toISOString()}] ${entry.message}`
      ).join('\n');

      process.send({
        type: 'ASYNC_PROGRESS_DATA',
        execId,
        progress: progressOutput,
        totalEntries: outputHistory.length,
        executionDuration: Date.now() - execution.startTime
      });
    } else {
      process.send({
        type: 'ASYNC_PROGRESS_DATA',
        execId,
        error: 'Async execution not found'
      });
    }
  } else if (msg.type === 'EXECUTE') {
    const execId = msg.execId;
    const code = msg.code;
    const workingDirectory = msg.workingDirectory;

    operationLogger.log('EXECUTE_START', { execId, workingDirectory });

    (async () => {
      startCapture(execId);

      // Track this execution with timeout detection
      const executionInfo = {
        id: execId,
        code: code,
        workingDirectory: workingDirectory,
        startTime: Date.now(),
        killed: false,
        handoverTimer: null,
        isAsync: false,
        outputHistory: []
      };
      runningExecutions.set(execId, executionInfo);

      // Set up async handover timer
      executionInfo.handoverTimer = setTimeout(() => {
        if (runningExecutions.has(execId) && !executionInfo.killed) {
          operationLogger.log('ASYNC_HANDOVER', { execId });
          moveToAsyncMode(execId);
        }
      }, asyncHandoverTimeout);

      try {
        process.chdir(workingDirectory);

        // Update context variables for current working directory
        global.__workingDirectory = workingDirectory;
        global.__dirname = workingDirectory;
        global.__filename = workingDirectory + '/[execute]';

        // Create a scoped require for the working directory
        const scopedRequire = createRequire(workingDirectory + '/package.json');
        global.require = scopedRequire;

        // Execute code in persistent context
        // Copy persistent context to global scope, skipping read-only properties
        for (const key in persistentContext) {
          try {
            global[key] = persistentContext[key];
          } catch (e) {
            // Skip read-only properties like 'navigator'
          }
        }

        // Execute the code with smart return value handling and validation
        let result;

        // Check if this is an ES module
        if (esModuleExecutor.isESModule(code)) {
          operationLogger.log('ES_MODULE_EXECUTION', { execId });
          try {
            result = await esModuleExecutor.executeESModule(code, workingDirectory);
          } catch (esModuleError) {
            console.error(`BRUTAL ERROR: ES module execution failed for execId ${execId}:`, esModuleError.message);
            console.error(`BRUTAL ERROR: Code that failed:`, code.substring(0, 500) + (code.length > 500 ? '...' : ''));
            throw new Error(`BRUTAL ERROR: ES module execution failed - NO FALLBACKS: ${esModuleError.message}`);
          }
        } else {
          // Regular JavaScript execution with syntax validation
          const validation = SyntaxValidator.validateJavaScript(code);
          if (!validation.isValid) {
            throw new Error(`Syntax validation failed: ${validation.errors.join(', ')}`);
          }

          operationLogger.log('JAVASCRIPT_EXECUTION', {
            execId,
            warnings: validation.warnings,
            suggestions: validation.suggestions
          });

          // Strategy 1: Try as pure expression (fastest for simple cases)
          try {
            result = await eval(`(async () => { return (${code}); })()`);
          } catch (expressionError) {
            // Strategy 2: Try to intelligently wrap the code
            // Check if code has multiple statements by looking for semicolons or newlines
            const trimmedCode = code.trim();
            const hasMultipleStatements = trimmedCode.includes(';') || trimmedCode.includes('\n');

            if (hasMultipleStatements) {
              // Strategy 2a: For multi-statement code, try to extract and return last expression
              const lines = trimmedCode.split(/[;\n]/).map(l => l.trim()).filter(l => l.length > 0);

              if (lines.length > 0) {
                const lastLine = lines[lines.length - 1];
                const previousLines = lines.slice(0, -1).join(';\n');

                // Check if last line looks like an expression (not a declaration/control flow)
                const isDeclaration = /^(const|let|var|function|class|if|for|while|do|switch|try)\s/.test(lastLine);

                if (!isDeclaration && previousLines) {
                  // Try executing all but last line, then return last line
                  try {
                    result = await eval(`(async () => { ${previousLines}; return (${lastLine}); })()`);
                  } catch (splitError) {
                    // If that fails, execute all as statements
                    result = await eval(`(async () => { ${code} })()`);
                  }
                } else {
                  // Last line is a declaration or no previous lines, execute as-is
                  result = await eval(`(async () => { ${code} })()`);
                }
              } else {
                result = await eval(`(async () => { ${code} })()`);
              }
            } else {
              // Strategy 2b: Single statement, execute as-is
              result = await eval(`(async () => { ${code} })()`);
            }
          }
        }

        // Save any new global variables back to persistent context
        const systemProps = new Set([
          '__filename', '__dirname', 'module', 'exports', 'require',
          'console', 'process', 'Buffer', 'global', 'setTimeout',
          'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
          'clearImmediate', 'clear_context', '__toolFunctions',
          '__callMCPTool', '__workingDirectory', 'navigator', 'window'
        ]);

        for (const key in global) {
          if (!systemProps.has(key) && key !== 'persistentContext') {
            try {
              persistentContext[key] = global[key];
            } catch (e) {
              // Skip properties that can't be serialized
            }
          }
        }

        // If the code returns a value, add it to output
        if (result !== undefined) {
          console.log(result);
        }

        const output = stopCapture();

        // Clean up execution tracking
        runningExecutions.delete(execId);

        // Mark async execution as completed if it exists in async executions
        if (asyncExecutions.has(execId)) {
          const asyncExec = asyncExecutions.get(execId);
          asyncExec.completed = true;
          asyncExec.completionTime = Date.now();
        }

        operationLogger.log('EXECUTE_SUCCESS', { execId });

        process.send({ type: 'EXEC_RESULT', execId, success: true, output });
      } catch (err) {
        // Enhanced error handling
        const errorInfo = await ErrorHandler.handleError(err, {
          execId,
          code: code.substring(0, 200), // Truncate for security
          workingDirectory
        });

        const output = stopCapture();

        // Clean up execution tracking
        runningExecutions.delete(execId);

        // Mark async execution as completed with error if it exists in async executions
        if (asyncExecutions.has(execId)) {
          const asyncExec = asyncExecutions.get(execId);
          asyncExec.completed = true;
          asyncExec.completionTime = Date.now();
          asyncExec.error = err.message;
        }

        operationLogger.log('EXECUTE_ERROR', { execId, error: errorInfo });

        process.send({
          type: 'EXEC_RESULT',
          execId,
          success: false,
          error: `${output}\nError: ${errorInfo.message}\n${errorInfo.suggestions.length > 0 ? '\nSuggestions:\n' + errorInfo.suggestions.map(s => `- ${s}`).join('\n') : ''}\n${err.stack}`
        });
      }
    })();
  } else if (msg.type === 'INIT_TOOLS') {
    operationLogger.log('INIT_TOOLS');
    // Initialize MCP tool functions with enhanced monitoring
    const { toolFunctions } = msg;

    // Store tool functions for re-initialization after clear_context
    global.__toolFunctions = toolFunctions;
    global.__callMCPTool = global.__callMCPTool;

    // Register tools with availability checker
    Object.keys(toolFunctions).forEach(toolName => {
      toolChecker.registerTool(toolName, () => toolFunctions[toolName]);
    });

    // Generate tool functions that call back to parent
    eval(toolFunctions);

    // Enhanced clear_context function
    global.clear_context = () => {
      operationLogger.log('CLEAR_CONTEXT');

      // Kill all running executions first
      for (const [execId, execution] of runningExecutions.entries()) {
        execution.killed = true;
        if (execution.handoverTimer) {
          clearTimeout(execution.handoverTimer);
        }
      }
      runningExecutions.clear();

      // Kill all async executions
      for (const [execId, execution] of asyncExecutions.entries()) {
        execution.killed = true;
      }
      asyncExecutions.clear();

      // Clear the persistent context
      for (const key of Object.keys(persistentContext)) {
        delete persistentContext[key];
      }

      // Preserve system functions and MCP infrastructure in global
      const preserve = new Set([
        '__filename', '__dirname', 'module', 'exports', 'require',
        'console', 'process', 'Buffer', 'global',
        'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        'setImmediate', 'clearImmediate',
        'clear_context', '__toolFunctions', '__callMCPTool', '__workingDirectory',
        'kill_execution', 'get_server_state', 'get_async_execution', 'list_async_executions'
      ]);

      // Clear user variables from global
      for (const key of Object.keys(global)) {
        if (!preserve.has(key)) {
          delete global[key];
        }
      }

      // Re-initialize all MCP tool functions
      if (global.__toolFunctions) {
        eval(global.__toolFunctions);
        console.log('[Context cleared and tools re-initialized]');
      } else {
        console.log('[Context cleared]');
      }

      // Clear operation logs
      operationLogger.clear();
    };

    // Log initialization complete
    operationLogger.log('INIT_COMPLETE', {
      toolsCount: Object.keys(toolFunctions).length,
      monitoringEnabled: true
    });

    originalConsoleLog('[Enhanced execution worker ready]');
    originalConsoleLog('[Features] File content validation, syntax validation, process health monitoring');
    originalConsoleLog('[Features] Tool availability checking, enhanced error handling, operation logging');
    originalConsoleLog('[Example] const result = await Read("file.txt");');
    originalConsoleLog('[Server State] This server persists across all executions with enhanced monitoring');
    originalConsoleLog('[Management] Use execute tool actions for async execution management');
    originalConsoleLog('[Management] Use clear_context() to reset everything');

    process.send({ type: 'INIT_COMPLETE' });
  }
});

// Helper function for MCP tool calls with enhanced monitoring
global.__callMCPTool = async (serverName, toolName, args) => {
  const callId = nextCallId++;

  operationLogger.log('MCP_CALL_START', { serverName, toolName, callId });

  return new Promise((resolve, reject) => {
    pendingMCPCalls.set(callId, { resolve, reject });

    process.send({
      type: 'MCP_CALL',
      callId,
      serverName,
      toolName,
      args
    });

    // Timeout of 180 seconds for long-running operations
    setTimeout(() => {
      if (pendingMCPCalls.has(callId)) {
        pendingMCPCalls.delete(callId);
        operationLogger.log('MCP_CALL_TIMEOUT', { serverName, toolName, callId }, 'error');
        reject(new Error('MCP call timeout'));
      }
    }, 180000);
  });
};

process.on('SIGINT', () => {
  operationLogger.log('SIGINT_RECEIVED');
  originalConsoleLog('[Enhanced execution worker] Received SIGINT, shutting down...');
  healthMonitor.stopMonitoring();
  process.exit(0);
});

process.on('SIGTERM', () => {
  operationLogger.log('SIGTERM_RECEIVED');
  originalConsoleLog('[Enhanced execution worker] Received SIGTERM, shutting down...');
  healthMonitor.stopMonitoring();
  process.exit(0);
});

// Start health monitoring
healthMonitor.startMonitoring();

originalConsoleLog('[Enhanced execution worker ready]');
originalConsoleLog('[Monitoring] Process health monitoring started');
originalConsoleLog('[Validation] File content and syntax validation enabled');
originalConsoleLog('[Error Handling] Enhanced error recovery system active');