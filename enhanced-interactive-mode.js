import readline from 'readline';
import chalk from 'chalk';
import { EventEmitter } from 'events';

class EnhancedInteractiveMode extends EventEmitter {
  constructor() {
    super();
    this.commandQueue = [];
    this.isInputVisible = false;
    this.currentInput = '';
    this.isPaused = false;
    this.rl = null;
    this.waitForInstructions = false;
    this.agentFinished = false;
    this.completionTimer = null;
    this.promptInterval = null;
    this.interruptRequested = false;
  }

  init() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: ''
    });

    this.setupReadline();
    this.setupKeyboardHandlers();
    this.setupImmediatePrompt();
  }

  setupImmediatePrompt() {
    // Show prompt area immediately upon initialization
    this.showInputArea();
    this.isInputVisible = true;

    // Start checking for user input periodically
    this.promptInterval = setInterval(() => {
      if (!this.isInputVisible && !this.isPaused) {
        this.showInputArea();
        this.isInputVisible = true;
      }
    }, 100);
  }

  setupReadline() {
    this.rl.on('line', (input) => {
      const trimmedInput = input.trim();

      if (this.isInputVisible) {
        this.clearInputArea();
        this.isInputVisible = false;
      }

      if (trimmedInput) {
        this.commandQueue.push(trimmedInput);

        // Emit interrupt signal if agent is running
        if (this.agentFinished || this.waitForInstructions) {
          this.emit('userCommand', trimmedInput);
        } else {
          this.interruptRequested = true;
          this.emit('interrupt', trimmedInput);
        }
      }

      this.currentInput = '';
      this.rl.setPrompt('');
      this.rl.prompt();
    });

    this.rl.on('close', () => {
      this.cleanup();
      process.exit(0);
    });
  }

  setupKeyboardHandlers() {
    const originalWrite = this.rl._writeToOutput;
    const self = this;

    this.rl._writeToOutput = function(stringToWrite) {
      if (stringToWrite.length > 0 && stringToWrite !== '\r\n') {
        const currentLine = this.line || '';
        if (currentLine.length > 0 && !self.isInputVisible) {
          self.showInputArea();
          self.isInputVisible = true;
        }
        self.currentInput = currentLine;
      }

      originalWrite.apply(this, arguments);
    };

    process.stdin.on('keypress', (str, key) => {
      if (key && key.name === 'escape') {
        if (self.isInputVisible) {
          self.clearInputArea();
          self.isInputVisible = false;
          self.currentInput = '';
          self.rl.line = '';
          self.rl.cursor = 0;
          self.rl.setPrompt('');
        }
      } else if (key && key.ctrl && key.name === 'c') {
        // Handle Ctrl-C gracefully
        if (self.isInputVisible) {
          self.clearInputArea();
          self.isInputVisible = false;
          self.currentInput = '';
          self.rl.line = '';
          self.rl.cursor = 0;
          self.rl.setPrompt('');
        }
        process.exit(0);
      }
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      readline.emitKeypressEvents(process.stdin);
    }
  }

  showInputArea() {
    const width = process.stdout.columns || 80;
    const separator = chalk.blue('─'.repeat(width));

    // Move to a new line and show the input area
    process.stdout.write('\n');
    process.stdout.write(separator + '\n');

    if (this.agentFinished) {
      process.stdout.write(chalk.green.bold('✓ Agent completed. Enter additional commands or press Ctrl+C to exit:\n'));
    } else {
      process.stdout.write(chalk.cyan.bold('💬 Enter command (will interrupt current execution) or press Escape to hide:\n'));
    }

    process.stdout.write(chalk.cyan.bold('> '));
  }

  clearInputArea() {
    // Clear the current line and move up
    readline.moveCursor(process.stdout, 0, -3);
    readline.clearScreenDown(process.stdout);
  }

  agentStarted() {
    this.agentFinished = false;
    this.interruptRequested = false;
    this.waitForInstructions = false;

    // Clear any completion timer
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
  }

  agentFinished() {
    this.agentFinished = true;
    this.interruptRequested = false;

    // Show prompt and wait for additional instructions
    if (this.isInputVisible) {
      this.clearInputArea();
    }
    this.showInputArea();
    this.isInputVisible = true;

    // Start waiting period for user instructions (3 minutes)
    this.waitForInstructions = true;

    this.completionTimer = setTimeout(() => {
      this.waitForInstructions = false;
      if (this.isInputVisible) {
        this.clearInputArea();
        this.isInputVisible = false;
      }
      console.log(chalk.yellow.bold('\n🕐 Wait period ended. Session will end on next command or Ctrl+C.'));
    }, 180000); // 3 minutes

    console.log(chalk.green.bold('\n✅ Task completed! Waiting for additional instructions...'));
    console.log(chalk.gray('   • Enter new commands to continue working'));
    console.log(chalk.gray('   • Press Escape to hide this prompt area'));
    console.log(chalk.gray('   • Press Ctrl+C to exit'));
    console.log(chalk.gray('   • Will automatically exit after 3 minutes of inactivity\n'));
  }

  pause() {
    this.isPaused = true;
    if (this.isInputVisible) {
      this.clearInputArea();
      this.isInputVisible = false;
    }
    // Keep readline active to detect interrupts and user input
    // Do NOT call rl.pause() - it blocks signal detection
  }

  resume() {
    this.isPaused = false;
    // Show prompt again when resuming if waiting for instructions
    if (this.waitForInstructions && !this.isInputVisible) {
      this.showInputArea();
      this.isInputVisible = true;
    }

    if (this.rl) {
      this.rl.setPrompt('');
      this.rl.prompt();
    }
  }

  hasCommands() {
    return this.commandQueue.length > 0;
  }

  getNextCommand() {
    return this.commandQueue.shift();
  }

  checkForInterrupt() {
    if (this.interruptRequested) {
      this.interruptRequested = false;
      return true;
    }
    return false;
  }

  cleanup() {
    // Clear timers
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }

    if (this.promptInterval) {
      clearInterval(this.promptInterval);
      this.promptInterval = null;
    }

    // Clear input area
    if (this.isInputVisible) {
      this.clearInputArea();
      this.isInputVisible = false;
    }

    // Restore terminal settings
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch (e) {}
    }

    // Close readline interface
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    console.log(chalk.gray('\n👋 Goodbye!'));
  }
}

export default EnhancedInteractiveMode;