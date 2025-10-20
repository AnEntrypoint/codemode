// Enhanced error handling for AST tools (inspired by mcp-repl)
export class ToolError extends Error {
  constructor(message, code = 'TOOL_ERROR', toolName = 'unknown', retryable = false, suggestions = []) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.tool = toolName;
    this.timestamp = Date.now();
    this.retryable = retryable;
    this.suggestions = suggestions;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      tool: this.tool,
      timestamp: this.timestamp,
      retryable: this.retryable,
      suggestions: this.suggestions
    };
  }

  toString() {
    let result = `${this.name} [${this.code}]: ${this.message}`;
    if (this.suggestions.length > 0) {
      result += '\nSuggestions:\n' + this.suggestions.map(s => `- ${s}`).join('\n');
    }
    return result;
  }
}

export class ValidationError extends ToolError {
  constructor(message, toolName = 'unknown') {
    super(message, 'VALIDATION_ERROR', toolName, false, [
      'Check that all required parameters are provided',
      'Verify parameter types match the expected schema',
      'Review the tool documentation for parameter requirements'
    ]);
    this.name = 'ValidationError';
  }
}

export class ExecutionError extends ToolError {
  constructor(message, toolName = 'unknown') {
    super(message, 'EXECUTION_ERROR', toolName, true, [
      'Try running the operation again',
      'Check if the working directory is accessible',
      'Verify that required dependencies are installed'
    ]);
    this.name = 'ExecutionError';
  }
}

export class SearchError extends ToolError {
  constructor(message, toolName = 'unknown') {
    super(message, 'SEARCH_ERROR', toolName, true, [
      'Try a different search query',
      'Check if the search path exists',
      'Consider using a more specific search pattern'
    ]);
    this.name = 'SearchError';
  }
}

export class TimeoutError extends ToolError {
  constructor(message, toolName = 'unknown', timeoutMs = 0) {
    super(message, 'TIMEOUT', toolName, true, [
      'Try reducing the scope of the operation',
      'Consider using a simpler tool for this task',
      'Break the operation into smaller chunks',
      `Increase timeout beyond ${timeoutMs}ms if needed`
    ]);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class ASTError extends ToolError {
  constructor(message, toolName = 'ast-tool', suggestions = []) {
    super(message, 'AST_ERROR', toolName, false, [
      'Check if AST functionality is available on this system',
      'Verify that @ast-grep/napi is properly installed',
      'Try running: npm run postinstall',
      ...suggestions
    ]);
    this.name = 'ASTError';
  }
}

export class PatternError extends ToolError {
  constructor(message, toolName = 'ast-tool', pattern = '') {
    super(message, 'PATTERN_ERROR', toolName, false, [
      'Check AST pattern syntax',
      'Verify pattern uses correct metavariables ($VAR, $FUNC, $$$)',
      'Review pattern examples in documentation',
      pattern ? `Pattern was: "${pattern}"` : 'No pattern provided'
    ]);
    this.name = 'PatternError';
    this.pattern = pattern;
  }
}

export class ToolErrorHandler {
  constructor(toolName = 'unknown') {
    this.toolName = toolName;
  }

  handleError(error, context = {}) {
    // Handle null/undefined errors
    if (!error) {
      return new ToolError('Unknown error occurred', 'UNKNOWN_ERROR', this.toolName, false, [
        'Check the tool parameters and try again'
      ]);
    }

    // If it's already our error type, return as-is
    if (error instanceof ToolError) {
      return error;
    }

    // Handle common error patterns
    const message = error.message || error.toString();

    if (message.includes('ENOENT') || message.includes('not found')) {
      return new SearchError(`File or directory not found: ${message}`, this.toolName);
    }

    if (message.includes('EACCES') || message.includes('permission denied')) {
      return new ToolError(`Permission denied: ${message}`, 'PERMISSION_DENIED', this.toolName, false, [
        'Check file and directory permissions',
        'Ensure the tool has necessary access rights'
      ]);
    }

    if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
      return new TimeoutError(`Operation timed out: ${message}`, this.toolName);
    }

    if (message.includes('ast-grep') || message.includes('AST')) {
      return new ASTError(`AST functionality error: ${message}`, this.toolName);
    }

    // Default error handling
    return new ExecutionError(message, this.toolName);
  }

  // Format error for user display
  formatError(error) {
    if (error instanceof ToolError) {
      return error.toString();
    }

    const handled = this.handleError(error);
    return handled.toString();
  }
}

// Convenience function for creating error handlers
export function createErrorHandler(toolName) {
  return new ToolErrorHandler(toolName);
}

// Pattern validation utilities
export class ASTPatternValidator {
  static validateAndFixPattern(pattern) {
    if (!pattern || typeof pattern !== 'string') {
      throw new PatternError(
        'Pattern must be a non-empty string',
        'ast-tool',
        pattern
      );
    }

    // Validate pattern length
    if (pattern.length > 1000) {
      throw new PatternError(
        'Pattern is too long (max 1000 characters)',
        'ast-tool',
        pattern
      );
    }

    // Basic syntax validation
    const fixes = [];
    let fixedPattern = pattern;

    // Common pattern fixes
    if (pattern.includes('$') && !pattern.match(/\$\w+/)) {
      fixes.push('Add proper metavariables ($VAR, $FUNC, $$$)');
    }

    if (pattern.includes('class ') && !pattern.includes('kind:')) {
      fixes.push('Consider using kind: class_declaration for class patterns');
    }

    if (pattern.includes('function ') && !pattern.includes('kind:')) {
      fixes.push('Consider using kind: function_declaration for function patterns');
    }

    return {
      originalPattern: pattern,
      fixedPattern: fixedPattern,
      fixes: fixes,
      isValid: fixes.length === 0
    };
  }

  static generatePatternGuidance(issues) {
    let guidance = '💡 Pattern Optimization Tips:\n\n';

    if (Array.isArray(issues)) {
      issues.forEach((issue, index) => {
        guidance += `${index + 1}. ${issue.message}\n`;
        if (issue.examples && issue.examples.length > 0) {
          guidance += '\n   Examples:\n';
          issue.examples.forEach(example => {
            guidance += `   ${example}\n`;
          });
        }
        guidance += '\n';
      });
    } else {
      guidance += '- Pattern is very broad - add more context for better results\n\n';
      guidance += '   Examples:\n';
      guidance += '   Instead of: "Component"\n';
      guidance += '   Try: "class Component" or "function Component()"\n\n';
      guidance += '   Instead of: "$VAR"\n';
      guidance += '   Try: "const $VAR =" or "let $VAR ="\n';
    }

    return guidance;
  }
}