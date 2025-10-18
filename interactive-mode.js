import readline from 'readline';
import chalk from 'chalk';

class InteractiveMode {
  constructor() {
    this.commandQueue = [];
    this.isInputVisible = false;
    this.currentInput = '';
    this.isPaused = false;
    this.rl = null;
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
      }

      this.currentInput = '';
      this.rl.setPrompt('');
      this.rl.prompt();
    });

    this.rl.on('close', () => {
      process.exit(0);
    });
  }

  setupKeyboardHandlers() {
    const originalWrite = this.rl._writeToOutput;
    const self = this;

    this.rl._writeToOutput = function(stringToWrite) {
      if (stringToWrite.length > 0 && stringToWrite !== '\r\n' && !self.isPaused) {
        const currentLine = this.line || '';
        if (currentLine.length > 0 && !self.isInputVisible) {
          self.showInputArea();
          self.isInputVisible = true;
        }
        self.currentInput = currentLine;
      }

      originalWrite.apply(this, arguments);
    };

    this.rl.on('SIGINT', () => {
      this.cleanup();
      process.exit(0);
    });
  }

  showInputArea() {
    const width = process.stdout.columns || 80;
    const separator = chalk.blue('─'.repeat(width));

    process.stdout.write('\n');
    process.stdout.write(separator + '\n');
    process.stdout.write(chalk.cyan.bold('> '));
  }

  clearInputArea() {
    readline.moveCursor(process.stdout, 0, -2);
    readline.clearScreenDown(process.stdout);
  }

  pause() {
    this.isPaused = true;
    if (this.isInputVisible) {
      this.clearInputArea();
      this.isInputVisible = false;
    }
    if (this.rl) {
      this.rl.pause();
    }
  }

  resume() {
    this.isPaused = false;
    if (this.rl) {
      this.rl.resume();
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

  cleanup() {
    if (this.isInputVisible) {
      this.clearInputArea();
      this.isInputVisible = false;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

export default InteractiveMode;
