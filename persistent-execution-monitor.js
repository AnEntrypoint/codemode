#!/usr/bin/env node

// Persistent Execution Monitor
// Monitors async executions and provides interruption notifications to agents

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class PersistentExecutionMonitor {
  constructor() {
    this.isRunning = false;
    this.monitorInterval = null;
    this.lastNotification = null;
    this.agentQueue = [];
    this.configPath = join(process.cwd(), '.codemode.json');
    this.mcpConfig = null;
    this.serverProcess = null;
    this.monitoringIntervalMs = 60000; // 60 seconds for agent completion monitoring
    this.handoverIntervalMs = 30000; // 30 seconds for active task monitoring
    this.lastCheckTime = Date.now();
    this.activeExecutions = new Map();
    this.completedExecutions = new Set();
    this.finishedExecutions = new Map(); // Track executions that finished but haven't been acknowledged
    this.forceShutdown = false; // Only allow shutdown when explicitly requested
  }

  async initialize() {
    console.log('[Persistent Monitor] Initializing persistent execution monitor...');

    // Load MCP configuration
    await this.loadConfig();

    // Start the monitoring system
    this.startMonitoring();

    console.log('[Persistent Monitor] ✓ Monitor initialized and running');
  }

  async loadConfig() {
    try {
      if (existsSync(this.configPath)) {
        this.mcpConfig = JSON.parse(readFileSync(this.configPath, 'utf8'));
        console.log('[Persistent Monitor] ✓ MCP configuration loaded');
      } else {
        throw new Error(`Config file not found: ${this.configPath}`);
      }
    } catch (error) {
      console.error('[Persistent Monitor] ✗ Failed to load config:', error.message);
      throw error;
    }
  }

  startMonitoring() {
    if (this.isRunning) {
      console.log('[Persistent Monitor] Monitoring already running');
      return;
    }

    this.isRunning = true;

    // Monitor for active task interruptions (30-second intervals)
    this.monitorInterval = setInterval(() => {
      this.checkActiveExecutions();
    }, this.handoverIntervalMs);

    // Monitor for agent completion notifications (60-second intervals)
    setTimeout(() => {
      this.startAgentCompletionMonitoring();
    }, this.monitoringIntervalMs);

    console.log('[Persistent Monitor] ✓ Monitoring started');
  }

  startAgentCompletionMonitoring() {
    if (!this.isRunning) return;

    // After agent completion, check every 60 seconds
    setInterval(() => {
      if (this.isRunning) {
        this.checkAndNotifyAgent();
      }
    }, this.monitoringIntervalMs);

    console.log('[Persistent Monitor] ✓ Agent completion monitoring started');
  }

  async checkActiveExecutions() {
    try {
      const executions = await this.getAsyncExecutions();

      if (executions.length === 0 && !this.forceShutdown) {
        // No executions running, check if we have finished executions to notify about
        await this.checkFinishedExecutions();
        return;
      }

      console.log(`[Persistent Monitor] Checking ${executions.length} active executions...`);

      const currentExecutionIds = new Set();

      for (const execution of executions) {
        const executionId = execution.id;
        currentExecutionIds.add(executionId);
        const lastCheck = this.activeExecutions.get(executionId) || 0;
        const now = Date.now();

        // Check if this execution just finished
        if (this.finishedExecutions.has(executionId)) {
          await this.createCompletionNotification(execution);
          this.finishedExecutions.delete(executionId);
          continue;
        }

        // Check if execution is new or has progressed since last check
        if (!this.activeExecutions.has(executionId) || (now - lastCheck) >= this.handoverIntervalMs) {
          const progress = await this.getExecutionProgress(executionId, lastCheck);

          if (progress && progress.hasNewOutput) {
            await this.createTaskNotification(execution, progress);
            this.activeExecutions.set(executionId, now);
          }
        }
      }

      // Check for executions that were running but now finished
      for (const [executionId, execution] of this.activeExecutions) {
        if (!currentExecutionIds.has(executionId)) {
          // Execution finished since last check
          this.finishedExecutions.set(executionId, {
            ...execution,
            finishedAt: Date.now()
          });
          this.activeExecutions.delete(executionId);
        }
      }

      // Check for newly finished executions
      await this.checkFinishedExecutions();

    } catch (error) {
      console.error('[Persistent Monitor] Error checking active executions:', error.message);
    }
  }

  async checkFinishedExecutions() {
    if (this.finishedExecutions.size === 0) return;

    console.log(`[Persistent Monitor] Checking ${this.finishedExecutions.size} finished executions...`);

    for (const [executionId, execution] of this.finishedExecutions) {
      try {
        // Get the complete execution log
        const fullLog = await this.getExecutionFullLog(executionId);

        if (fullLog) {
          await this.createCompletionNotification(execution, fullLog);
          this.finishedExecutions.delete(executionId);
        }
      } catch (error) {
        console.error(`[Persistent Monitor] Error getting completion log for ${executionId}:`, error.message);
        // Keep trying for failed executions
      }
    }
  }

  async getAsyncExecutions() {
    try {
      const result = await this.executeMCPAction('list_async_executions');
      return result.executions || [];
    } catch (error) {
      // Silent failure - timeouts are expected when no executions are running
      return [];
    }
  }

  async getExecutionProgress(executionId, since) {
    try {
      const sinceTime = since ? new Date(since).toISOString() : undefined;
      const result = await this.executeMCPAction('get_progress', {
        executionId,
        since: sinceTime
      });

      return {
        hasNewOutput: result.totalEntries > 0,
        progress: result.progress,
        totalEntries: result.totalEntries,
        executionDuration: result.executionDuration
      };
    } catch (error) {
      console.error(`[Persistent Monitor] Failed to get progress for ${executionId}:`, error.message);
      return null;
    }
  }

  async createTaskNotification(execution, progress) {
    const notification = {
      id: `task_notify_${execution.id}_${Date.now()}`,
      executionId: execution.id,
      type: 'PERSISTENT_TASK_UPDATE',
      timestamp: Date.now(),
      title: `Persistent Task Update - Execution ${execution.id}`,
      message: this.formatTaskMessage(execution, progress),
      execution: {
        id: execution.id,
        workingDirectory: execution.workingDirectory,
        startTime: execution.startTime,
        asyncStartTime: execution.asyncStartTime,
        duration: Math.round((Date.now() - execution.startTime) / 1000),
        outputHistoryLength: execution.outputHistoryLength,
        isKilled: execution.killed
      },
      progress: {
        totalEntries: progress.totalEntries,
        executionDuration: progress.executionDuration,
        recentOutput: this.extractRecentOutput(progress.progress)
      },
      actions: [
        {
          name: 'continue_monitoring',
          description: 'Continue monitoring this task',
          parameters: { executionId: execution.id }
        },
        {
          name: 'kill_task',
          description: 'Kill this execution',
          parameters: { executionId: execution.id }
        },
        {
          name: 'get_full_log',
          description: 'Get complete execution log',
          parameters: { executionId: execution.id }
        }
      ]
    };

    // Add to queue (replace any existing unprocessed notification)
    this.addToAgentQueue(notification);

    console.log(`[Persistent Monitor] ✓ Created task notification for execution ${execution.id}`);
  }

  formatTaskMessage(execution, progress) {
    const duration = Math.round((Date.now() - execution.startTime) / 1000);
    const recentOutput = this.extractRecentOutput(progress.progress);

    return `Persistent execution ${execution.id} has been running for ${duration}s and has produced new output:\n\n${recentOutput}\n\n[Total entries: ${progress.totalEntries}] [Duration: ${duration}s]`;
  }

  extractRecentOutput(progressOutput) {
    if (!progressOutput) return 'No recent output';

    const lines = progressOutput.split('\n').filter(line => line.trim());
    // Get last 5 lines to keep notification concise
    return lines.slice(-5).join('\n');
  }

  async createCompletionNotification(execution, fullLog = null) {
    const duration = Math.round((Date.now() - execution.startTime) / 1000);
    const finishedAt = execution.finishedAt || Date.now();

    const notification = {
      id: `completion_${execution.id}_${Date.now()}`,
      executionId: execution.id,
      type: 'EXECUTION_COMPLETED',
      timestamp: Date.now(),
      title: `Execution Completed - ${execution.id}`,
      message: this.formatCompletionMessage(execution, duration, fullLog),
      execution: {
        id: execution.id,
        workingDirectory: execution.workingDirectory,
        startTime: execution.startTime,
        asyncStartTime: execution.asyncStartTime,
        finishedAt: finishedAt,
        duration: duration,
        outputHistoryLength: execution.outputHistoryLength,
        isKilled: execution.killed,
        status: execution.killed ? 'killed' : 'completed'
      },
      fullLog: fullLog,
      actions: [
        {
          name: 'acknowledge_completion',
          description: 'Acknowledge execution completion and clear history',
          parameters: { executionId: execution.id }
        },
        {
          name: 'consolidate_history',
          description: 'Consolidate execution history for analysis',
          parameters: { executionId: execution.id }
        },
        {
          name: 'restart_execution',
          description: 'Restart this execution with same parameters',
          parameters: { executionId: execution.id }
        }
      ]
    };

    // Add to queue with highest priority
    this.addToAgentQueue(notification, true);

    console.log(`[Persistent Monitor] ✓ Created completion notification for execution ${execution.id}`);
  }

  formatCompletionMessage(execution, duration, fullLog) {
    const status = execution.killed ? 'killed' : 'completed';
    const message = `Execution ${execution.id} has ${status} after ${duration}s.`;

    if (fullLog) {
      const lastLines = this.extractRecentOutput(fullLog);
      return `${message}\n\nFinal output:\n${lastLines}\n\n[Full history available for consolidation]`;
    }

    return `${message}\n\n[Total duration: ${duration}s] [Status: ${status}]`;
  }

  async getExecutionFullLog(executionId) {
    try {
      const result = await this.executeMCPAction('get_async_log', { executionId });
      return result.output || result;
    } catch (error) {
      console.error(`[Persistent Monitor] Failed to get full log for ${executionId}:`, error.message);
      return null;
    }
  }

  addToAgentQueue(notification, isPriority = false) {
    // Remove any existing unprocessed notification for the same execution
    // But keep completion notifications as they have different type
    this.agentQueue = this.agentQueue.filter(n =>
      n.processed ||
      (n.executionId === notification.executionId && n.type === notification.type)
    );

    // Add new notification
    const notificationWithMeta = {
      ...notification,
      processed: false,
      createdAt: Date.now(),
      isPriority: isPriority
    };

    if (isPriority) {
      // Insert priority notifications at the front
      this.agentQueue.unshift(notificationWithMeta);
    } else {
      // Add regular notifications to the end
      this.agentQueue.push(notificationWithMeta);
    }

    // Keep only the latest unprocessed notification per execution per type
    const unprocessed = this.agentQueue.filter(n => !n.processed);
    const toKeep = new Set();

    for (const notif of unprocessed) {
      const key = `${notif.executionId}_${notif.type}`;
      if (!toKeep.has(key)) {
        toKeep.add(key);
      } else {
        // Remove duplicate (keep the newer one)
        const index = this.agentQueue.indexOf(notif);
        if (index > -1) {
          this.agentQueue.splice(index, 1);
        }
      }
    }

    // NO TIMEOUT REMOVAL - notifications persist until acknowledged
    console.log(`[Persistent Monitor] ✓ Added ${isPriority ? 'priority ' : ''}notification to queue (queue size: ${this.agentQueue.length})`);
  }

  async checkAndNotifyAgent() {
    try {
      const executions = await this.getAsyncExecutions();
      const hasActiveExecutions = executions.length > 0;
      const hasPendingNotifications = this.agentQueue.filter(n => !n.processed).length > 0;
      const hasFinishedExecutions = this.finishedExecutions.size > 0;

      // Stop monitoring if there's nothing to monitor
      if (!hasActiveExecutions && !hasPendingNotifications && !hasFinishedExecutions && !this.forceShutdown) {
        console.log('[Persistent Monitor] No active executions or pending notifications - stopping monitoring');
        this.stop();
        return;
      }

      // Check for long-running executions that need attention
      if (hasActiveExecutions) {
        const longRunningExecutions = executions.filter(exec => {
          const duration = (Date.now() - exec.startTime) / 1000;
          return duration > 120; // Executions running longer than 2 minutes
        });

        if (longRunningExecutions.length > 0) {
          console.log(`[Persistent Monitor] Found ${longRunningExecutions.length} long-running executions needing attention`);

          for (const execution of longRunningExecutions) {
            const progress = await this.getExecutionProgress(execution.id);
            if (progress) {
              await this.createTaskNotification(execution, progress);
            }
          }
        }
      }

      // Check finished executions
      await this.checkFinishedExecutions();

      // Report monitoring status
      const status = {
        activeExecutions: executions.length,
        pendingNotifications: this.agentQueue.filter(n => !n.processed).length,
        finishedExecutions: this.finishedExecutions.size,
        monitoringActive: true
      };

      if (hasActiveExecutions || hasPendingNotifications || hasFinishedExecutions) {
        console.log(`[Persistent Monitor] Status: ${status.activeExecutions} active, ${status.pendingNotifications} pending, ${status.finishedExecutions} finished`);
      }

    } catch (error) {
      console.error('[Persistent Monitor] Error in agent completion check:', error.message);
    }
  }

  async executeMCPAction(action, parameters = {}) {
    return new Promise((resolve, reject) => {
      // Start a temporary MCP client to execute the action
      const client = spawn('node', [join(__dirname, 'code-mode.js')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd()
      });

      let output = '';
      let errorOutput = '';

      client.stdout.on('data', (data) => {
        output += data.toString();
      });

      client.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      client.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`MCP client exited with code ${code}: ${errorOutput}`));
          return;
        }

        try {
          // Parse the output to extract the result
          const result = this.parseMCPResult(output);
          resolve(result);
        } catch (error) {
          reject(new Error(`Failed to parse MCP result: ${error.message}`));
        }
      });

      // Send the execute request
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'execute',
          arguments: {
            action,
            ...parameters,
            workingDirectory: process.cwd()
          }
        }
      };

      client.stdin.write(JSON.stringify(request) + '\n');
      client.stdin.end();

      // Timeout after 30 seconds
      setTimeout(() => {
        client.kill();
        reject(new Error('MCP request timeout'));
      }, 30000);
    });
  }

  parseMCPResult(output) {
    try {
      const lines = output.split('\n').filter(line => line.trim());
      for (const line of lines) {
        if (line.startsWith('{') && line.endsWith('}')) {
          return JSON.parse(line);
        }
      }
      throw new Error('No valid JSON found in output');
    } catch (error) {
      throw new Error(`Failed to parse MCP output: ${error.message}`);
    }
  }

  getNextUnprocessedNotification() {
    const notification = this.agentQueue.find(n => !n.processed);
    if (notification) {
      notification.processed = true;
    }
    return notification || null;
  }

  markNotificationProcessed(notificationId) {
    const notification = this.agentQueue.find(n => n.id === notificationId);
    if (notification) {
      notification.processed = true;
    }
  }

  stop() {
    console.log('[Persistent Monitor] Stopping persistent execution monitor...');

    this.isRunning = false;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
    }

    console.log('[Persistent Monitor] ✓ Monitor stopped');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      queueSize: this.agentQueue.length,
      unprocessedCount: this.agentQueue.filter(n => !n.processed).length,
      activeExecutions: this.activeExecutions.size,
      lastCheckTime: this.lastCheckTime,
      uptime: Date.now() - this.lastCheckTime
    };
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const monitor = new PersistentExecutionMonitor();

  process.on('SIGINT', () => {
    console.log('\n[Persistent Monitor] Received SIGINT, shutting down...');
    monitor.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[Persistent Monitor] Received SIGTERM, shutting down...');
    monitor.stop();
    process.exit(0);
  });

  monitor.initialize().catch(error => {
    console.error('[Persistent Monitor] Failed to initialize:', error);
    process.exit(1);
  });
}

export default PersistentExecutionMonitor;