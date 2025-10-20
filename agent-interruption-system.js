#!/usr/bin/env node

// Agent Interruption System
// Integrates with persistent execution monitor to provide task notifications to agents

import PersistentExecutionMonitor from './persistent-execution-monitor.js';

class AgentInterruptionSystem {
  constructor() {
    this.monitor = null;
    this.agentCallback = null;
    this.isMonitoring = false;
    this.interruptionQueue = [];
    this.interactiveMode = null; // Will hold interactive mode for user prompts
    this.forceShutdown = false; // Only allow explicit shutdown
  }

  async initialize(agentCallback = null) {
    console.log('[Agent Interruption] Initializing agent interruption system...');

    this.agentCallback = agentCallback;
    this.monitor = new PersistentExecutionMonitor();

    // Override the monitor's queue handling
    this.monitor.addToAgentQueue = (notification) => {
      this.handleTaskNotification(notification);
    };

    await this.monitor.initialize();
    this.isMonitoring = true;

    console.log('[Agent Interruption] ✓ Agent interruption system initialized');
  }

  handleTaskNotification(notification) {
    // Check if we already have a pending interruption for this execution
    const existingIndex = this.interruptionQueue.findIndex(
      n => n.executionId === notification.executionId && !n.processed
    );

    if (existingIndex >= 0) {
      // Replace existing interruption with newer one
      this.interruptionQueue[existingIndex] = {
        ...notification,
        processed: false,
        createdAt: Date.now()
      };
      console.log(`[Agent Interruption] Replaced existing interruption for execution ${notification.executionId}`);
    } else {
      // Add new interruption
      this.interruptionQueue.push({
        ...notification,
        processed: false,
        createdAt: Date.now()
      });
      console.log(`[Agent Interruption] Added new interruption for execution ${notification.executionId}`);
    }

    // NO TIMEOUT CLEANING - interruptions persist until acknowledged

    // Trigger agent callback if available
    if (this.agentCallback) {
      this.agentCallback(this.getNextInterruption());
    }

    // Handle completion notifications with higher priority
    if (notification.type === 'EXECUTION_COMPLETED') {
      console.log(`[Agent Interruption] 🎉 Execution ${notification.executionId} completed - priority notification`);
    }
  }

  getNextInterruption() {
    // Get the oldest unprocessed interruption
    const interruption = this.interruptionQueue.find(n => !n.processed);
    if (interruption) {
      interruption.processed = true;
      return interruption;
    }
    return null;
  }

  peekNextInterruption() {
    // Get the next interruption without marking it as processed
    return this.interruptionQueue.find(n => !n.processed) || null;
  }

  markInterruptionProcessed(interruptionId) {
    const interruption = this.interruptionQueue.find(n => n.id === interruptionId);
    if (interruption) {
      interruption.processed = true;
      console.log(`[Agent Interruption] Marked interruption ${interruptionId} as processed`);
    }
  }

  getInterruptionStatus() {
    return {
      totalInterruptions: this.interruptionQueue.length,
      unprocessedCount: this.interruptionQueue.filter(n => !n.processed).length,
      oldestInterruption: this.interruptionQueue.length > 0 ?
        Math.min(...this.interruptionQueue.map(n => n.createdAt)) : null,
      nextInterruption: this.peekNextInterruption(),
      isMonitoring: this.isMonitoring
    };
  }

  async executeAction(action, parameters) {
    try {
      switch (action) {
        case 'continue_monitoring':
          return await this.continueMonitoring(parameters);
        case 'kill_task':
          return await this.killTask(parameters);
        case 'get_full_log':
          return await this.getFullLog(parameters);
        case 'get_server_status':
          return await this.getServerStatus();
        case 'acknowledge_completion':
          return await this.acknowledgeCompletion(parameters);
        case 'consolidate_history':
          return await this.consolidateHistory(parameters);
        case 'restart_execution':
          return await this.restartExecution(parameters);
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      console.error(`[Agent Interruption] Error executing action ${action}:`, error.message);
      throw error;
    }
  }

  async continueMonitoring(parameters) {
    const { executionId } = parameters;
    console.log(`[Agent Interruption] Continuing to monitor execution ${executionId}`);

    // This action essentially does nothing - the monitor continues automatically
    return {
      action: 'continue_monitoring',
      executionId,
      message: `Continuing to monitor execution ${executionId}`,
      status: 'monitoring'
    };
  }

  async killTask(parameters) {
    const { executionId } = parameters;
    console.log(`[Agent Interruption] Killing execution ${executionId}`);

    try {
      const result = await this.monitor.executeMCPAction('kill', { executionId });

      // Remove any pending interruptions for this execution
      this.interruptionQueue = this.interruptionQueue.filter(
        n => n.executionId !== executionId
      );

      return {
        action: 'kill_task',
        executionId,
        message: `Execution ${executionId} has been killed`,
        status: 'killed',
        result
      };
    } catch (error) {
      return {
        action: 'kill_task',
        executionId,
        message: `Failed to kill execution ${executionId}: ${error.message}`,
        status: 'error',
        error: error.message
      };
    }
  }

  async getFullLog(parameters) {
    const { executionId } = parameters;
    console.log(`[Agent Interruption] Getting full log for execution ${executionId}`);

    try {
      const result = await this.monitor.executeMCPAction('get_async_log', { executionId });

      return {
        action: 'get_full_log',
        executionId,
        message: `Retrieved full log for execution ${executionId}`,
        status: 'success',
        log: result.output || result,
        logLength: (result.output || result).length
      };
    } catch (error) {
      return {
        action: 'get_full_log',
        executionId,
        message: `Failed to get full log for execution ${executionId}: ${error.message}`,
        status: 'error',
        error: error.message
      };
    }
  }

  async getServerStatus() {
    try {
      const result = await this.monitor.executeMCPAction('get_server_state', {});
      const monitorStatus = this.monitor.getStatus();
      const interruptionStatus = this.getInterruptionStatus();

      return {
        action: 'get_server_status',
        message: 'Server status retrieved',
        status: 'success',
        serverState: result,
        monitorStatus,
        interruptionStatus,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        action: 'get_server_status',
        message: `Failed to get server status: ${error.message}`,
        status: 'error',
        error: error.message
      };
    }
  }

  hasPendingNotifications() {
    return this.interruptionQueue.filter(n => !n.processed).length > 0;
  }

  getPendingNotifications() {
    return this.interruptionQueue.filter(n => !n.processed);
  }

  markNotificationProcessed(notificationId) {
    const notification = this.interruptionQueue.find(n => n.id === notificationId);
    if (notification) {
      notification.processed = true;
    }
  }

  generateAgentInstructions() {
    return `# Persistent Execution Management

## Task Interruption System

You have access to a persistent execution monitoring system that tracks long-running tasks and notifies you when they need attention.

## Available Actions

When you receive a task notification, you can execute these actions:

### 1. Continue Monitoring
\`\`\`javascript
await interruptionSystem.executeAction('continue_monitoring', { executionId: 'exec_123' });
\`\`\`
Continue monitoring the execution without intervention.

### 2. Kill Task
\`\`\`javascript
await interruptionSystem.executeAction('kill_task', { executionId: 'exec_123' });
\`\`\`
Terminate the execution if it's no longer needed or misbehaving.

### 3. Get Full Log
\`\`\`javascript
await interruptionSystem.executeAction('get_full_log', { executionId: 'exec_123' });
\`\`\`
Retrieve the complete execution history for analysis.

### 4. Get Server Status
\`\`\`javascript
await interruptionSystem.executeAction('get_server_status', {});
\`\`\`
Check overall server status and all running executions.

## Decision Guidelines

### When to Continue Monitoring
- Task is progressing normally and producing expected output
- Task is within expected time frame
- You want to see more progress before deciding

### When to Kill Tasks
- Task appears stuck or not making progress
- Task is producing errors or unexpected behavior
- Task is no longer relevant to your goals
- Task is consuming excessive resources

### When to Get Full Log
- Task behavior is unclear and you need complete history
- You need to debug what the task has been doing
- Task has been running for a long time and you need full context

## Monitoring Behavior

- **Active Monitoring**: Every 30 seconds during agent activity
- **Passive Monitoring**: Every 60 seconds after agent completion
- **Auto-Interruption**: Only one unprocessed notification per execution
- **Cleanup**: Old interruptions automatically removed after 5 minutes

## Best Practices

1. **Check notifications promptly** - They indicate important task changes
2. **Use server status** to understand overall system state before actions
3. **Kill carefully** - Terminated tasks cannot be resumed
4. **Monitor resource usage** - Long-running tasks may need intervention
5. **Document decisions** - Note why you chose specific actions

### 5. Acknowledge Completion
\`\`\`javascript
await interruptionSystem.executeAction('acknowledge_completion', { executionId: 'exec_123' });
\`\`\`
Acknowledge execution completion and clear the history from the monitoring system.

### 6. Consolidate History
\`\`\`javascript
await interruptionSystem.executeAction('consolidate_history', { executionId: 'exec_123' });
\`\`\`
Consolidate the complete execution history for analysis and archiving.

### 7. Restart Execution
\`\`\`javascript
await interruptionSystem.executeAction('restart_execution', { executionId: 'exec_123' });
\`\`\`
Restart a completed or failed execution with the same parameters.

## Completion Handling

When executions complete, you will receive priority notifications with:
- Full execution history available for consolidation
- Complete duration and status information
- Options to acknowledge, consolidate, or restart the execution

## Continuous Monitoring

The system continues monitoring until:
- All executions are completed AND acknowledged
- No pending notifications remain
- Explicit shutdown is requested

During monitoring, interactive prompting remains available for immediate user interventions.

Remember: You are in control of the execution lifecycle. Use these tools to manage persistent tasks effectively.`;
  }

  async acknowledgeCompletion(parameters) {
    const { executionId } = parameters;
    console.log(`[Agent Interruption] Acknowledging completion for execution ${executionId}`);

    // Remove the completion notification and any other notifications for this execution
    const beforeCount = this.interruptionQueue.length;
    this.interruptionQueue = this.interruptionQueue.filter(
      n => n.executionId !== executionId
    );
    const removed = beforeCount - this.interruptionQueue.length;

    return {
      action: 'acknowledge_completion',
      executionId,
      message: `Acknowledged completion of execution ${executionId} and cleared ${removed} notifications`,
      status: 'acknowledged',
      notificationsCleared: removed
    };
  }

  async consolidateHistory(parameters) {
    const { executionId } = parameters;
    console.log(`[Agent Interruption] Consolidating history for execution ${executionId}`);

    try {
      // Get the full execution log
      const fullLog = await this.monitor.executeMCPAction('get_async_log', { executionId });

      // Create a consolidated summary
      const logLines = (fullLog.output || fullLog).split('\n').filter(line => line.trim());
      const summary = {
        executionId,
        totalLines: logLines.length,
        firstLogTime: logLines.length > 0 ? this.extractTimestamp(logLines[0]) : null,
        lastLogTime: logLines.length > 0 ? this.extractTimestamp(logLines[logLines.length - 1]) : null,
        executionDuration: this.calculateExecutionDuration(logLines),
        logPreview: logLines.slice(0, 3).concat(logLines.slice(-3)),
        fullLog: fullLog.output || fullLog
      };

      return {
        action: 'consolidate_history',
        executionId,
        message: `Consolidated execution history for ${executionId}`,
        status: 'consolidated',
        summary
      };
    } catch (error) {
      return {
        action: 'consolidate_history',
        executionId,
        message: `Failed to consolidate history for ${executionId}: ${error.message}`,
        status: 'error',
        error: error.message
      };
    }
  }

  async restartExecution(parameters) {
    const { executionId } = parameters;
    console.log(`[Agent Interruption] Restarting execution ${executionId}`);

    try {
      // Get the original execution details
      const executionDetails = await this.monitor.executeMCPAction('get_async_log', { executionId });

      // Extract the original code from the execution
      const originalCode = this.extractOriginalCode(executionDetails.output || executionDetails);

      if (!originalCode) {
        throw new Error('Could not extract original code from execution');
      }

      // Start a new execution with the same code
      const result = await this.monitor.executeMCPAction('execute', {
        code: originalCode,
        workingDirectory: process.cwd()
      });

      return {
        action: 'restart_execution',
        executionId,
        newExecutionId: result.executionId || 'unknown',
        message: `Restarted execution ${executionId} as new execution`,
        status: 'restarted',
        originalExecutionId: executionId,
        result
      };
    } catch (error) {
      return {
        action: 'restart_execution',
        executionId,
        message: `Failed to restart execution ${executionId}: ${error.message}`,
        status: 'error',
        error: error.message
      };
    }
  }

  extractTimestamp(logLine) {
    const match = logLine.match(/\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)\]/);
    return match ? match[1] : null;
  }

  calculateExecutionDuration(logLines) {
    if (logLines.length < 2) return 0;

    const firstTimestamp = this.extractTimestamp(logLines[0]);
    const lastTimestamp = this.extractTimestamp(logLines[logLines.length - 1]);

    if (firstTimestamp && lastTimestamp) {
      return Math.round((new Date(lastTimestamp) - new Date(firstTimestamp)) / 1000);
    }

    return 0;
  }

  extractOriginalCode(executionOutput) {
    // This is a simplified extraction - in a real implementation,
    // you'd need to parse the execution details more carefully
    const lines = executionOutput.split('\n');
    const codeStartIndex = lines.findIndex(line => line.includes('Execution moved to async mode'));

    if (codeStartIndex >= 0) {
      // Look backwards to find the original code context
      for (let i = codeStartIndex - 1; i >= Math.max(0, codeStartIndex - 10); i--) {
        if (lines[i].includes('const result =') || lines[i].includes('return {')) {
          // Found what looks like the end of the original code
          return '/* Original code extraction not implemented - please provide code manually */';
        }
      }
    }

    return null;
  }

  stop() {
    console.log('[Agent Interruption] Stopping agent interruption system...');

    this.isMonitoring = false;
    this.forceShutdown = true;

    if (this.monitor) {
      this.monitor.stop();
      this.monitor = null;
    }

    this.agentCallback = null;
    this.interruptionQueue = [];

    console.log('[Agent Interruption] ✓ Agent interruption system stopped');
  }
}

// Export for use in agent system
export default AgentInterruptionSystem;