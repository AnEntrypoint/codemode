// AST-grep wrapper for universal cross-platform AST-based linting
let astGrep = null;
let astGrepAvailable = false;
let universalIgnorePatterns = [];

// Load universal ignore patterns
async function loadUniversalIgnorePatterns() {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const ignorePath = path.join(process.cwd(), 'universal-ignore.txt');

    if (fs.existsSync(ignorePath)) {
      const content = fs.readFileSync(ignorePath, 'utf8');
      return content
        .split('\n')
        .filter(line => line.trim() && !line.startsWith('#'))
        .map(line => line.trim());
    }
  } catch (error) {
    // Fallback to basic patterns
  }

  return [
    'node_modules/**',
    '.git/**',
    'build/**',
    'dist/**',
    'coverage/**',
    '*.log',
    '.DS_Store',
    'Thumbs.db',
    'test-*.js',
    '*.test.js',
    '*.spec.js'
  ];
}

// Initialize the module synchronously with a promise-based approach
let initializationPromise = null;

async function ensureInitialized() {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async function() {
    try {
      const module = await import('@ast-grep/napi');
      astGrep = module;
      astGrepAvailable = true;
      universalIgnorePatterns = await loadUniversalIgnorePatterns();
      return true;
    } catch (error) {
      // Silently degrade - only log in development
      if (process.env.NODE_ENV === 'development') {
        console.error('⚠️  @ast-grep/napi native binding not available. AST linting will be disabled.');
        console.error('   Try running: npm install to rebuild native modules.');
      }
      astGrepAvailable = false;
      universalIgnorePatterns = await loadUniversalIgnorePatterns();
      return false;
    }
  })();

  return initializationPromise;
}

export const isAstGrepAvailable = async () => {
  await ensureInitialized();
  return astGrepAvailable;
};

export const parse = async (language, code) => {
  await ensureInitialized();
  return astGrepAvailable ? astGrep.parse(language, code) : null;
};

export function ensureAstGrepAvailable() {
  if (!astGrepAvailable) {
    throw new Error(
      'AST functionality is not available on this system. ' +
      'The @ast-grep/napi native binding could not be loaded. ' +
      'This feature requires native bindings that may not be available on all platforms.'
    );
  }
}

// Common linting rules for universal code quality
export const LINTING_RULES = {
  // JavaScript/TypeScript rules
  javascript: [
    {
      name: 'console-statements',
      pattern: 'console.log($$$)',
      message: 'Console statement found - should be removed for production',
      severity: 'warning'
    },
    {
      name: 'debugger-statements',
      pattern: 'debugger',
      message: 'Debugger statement found - must be removed before production',
      severity: 'error'
    },
    {
      name: 'var-declarations',
      pattern: 'var $NAME',
      message: 'Use const or let instead of var for better scoping',
      severity: 'warning'
    },
    {
      name: 'todo-comments',
      pattern: '// TODO',
      message: 'TODO comment found - should be addressed',
      severity: 'info'
    },
    {
      name: 'fixme-comments',
      pattern: '// FIXME',
      message: 'FIXME comment found - should be addressed',
      severity: 'warning'
    }
  ],

  // React/JSX rules
  react: [
    {
      name: 'console-in-react',
      pattern: 'console.log($$$)',
      message: 'Console statement in React component',
      severity: 'warning'
    },
    {
      name: 'react-keys-missing',
      pattern: '{$$$}.map($ITEM => <$COMPONENT $$$)',
      message: 'Array.map without key prop - React performance issue',
      severity: 'warning'
    }
  ],

  // General patterns across all languages
  universal: [
    {
      name: 'hardcoded-secrets',
      pattern: 'api_key|secret|password|token',
      message: 'Potential hardcoded secret detected',
      severity: 'error'
    }
  ]
};

export class ASTLinter {
  constructor(workingDirectory = process.cwd()) {
    this.workingDirectory = workingDirectory;
    this.errors = [];
    this.warnings = [];
    this.info = [];
  }

  detectLanguageFromExtension(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const extensionMap = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'mjs': 'javascript',
      'c': 'c',
      'cpp': 'cpp',
      'cc': 'cpp',
      'cxx': 'cpp',
      'py': 'python',
      'go': 'go',
      'rs': 'rust',
      'java': 'java'
    };
    return extensionMap[ext] || 'javascript';
  }

  async lintFile(filePath, content = null) {
    if (!astGrepAvailable) {
      return { issues: [], available: false };
    }

    try {
      const fs = await import('fs');
      const code = content || fs.readFileSync(filePath, 'utf8');
      const language = this.detectLanguageFromExtension(filePath);

      const issues = [];

      // Get relevant rules for this language
      const rules = [
        ...LINTING_RULES.universal,
        ...LINTING_RULES.javascript,
        ...(language === 'typescript' ? LINTING_RULES.javascript : []),
        ...(filePath.includes('.jsx') || filePath.includes('.tsx') ? LINTING_RULES.react : [])
      ];

      const root = astGrep.parse(language, code);
      const rootNode = root.root();

      for (const rule of rules) {
        try {
          const matches = rootNode.findAll(rule.pattern);

          matches.forEach(match => {
            const range = match.range();
            issues.push({
              file: filePath,
              line: range.start.line,
              column: range.start.column,
              severity: rule.severity,
              message: rule.message,
              rule: rule.name,
              pattern: rule.pattern,
              text: match.text(),
              start: range.start.index,
              end: range.end.index
            });
          });
        } catch (patternError) {
          // Skip invalid patterns silently
          continue;
        }
      }

      return { issues, available: true };
    } catch (error) {
      return { issues: [], available: false, error: error.message };
    }
  }

  async lintDirectory(directory = this.workingDirectory, options = {}) {
    if (!astGrepAvailable) {
      return {
        available: false,
        totalIssues: 0,
        errors: 0,
        warnings: 0,
        info: 0,
        files: []
      };
    }

    const fs = await import('fs');
    const path = await import('path');

    const {
      recursive = true,
      extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
      maxFiles = 100
    } = options;

    const allIssues = [];
    const processedFiles = [];

    const scanDirectory = (dir, depth = 0) => {
      if (depth > 5 || processedFiles.length >= maxFiles) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (processedFiles.length >= maxFiles) break;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory() && recursive) {
            // Skip node_modules and common ignore directories
            if (!['node_modules', '.git', '.vscode', '.idea', 'dist', 'build'].includes(entry.name)) {
              scanDirectory(fullPath, depth + 1);
            }
          } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
            const result = this.lintFile(fullPath);
            if (result.issues.length > 0) {
              allIssues.push(...result.issues);
            }
            processedFiles.push(fullPath);
          }
        }
      } catch (error) {
        // Skip unreadable directories
      }
    };

    scanDirectory(directory);

    const errors = allIssues.filter(i => i.severity === 'error').length;
    const warnings = allIssues.filter(i => i.severity === 'warning').length;
    const info = allIssues.filter(i => i.severity === 'info').length;

    return {
      available: true,
      totalIssues: allIssues.length,
      errors,
      warnings,
      info,
      files: processedFiles,
      issues: allIssues
    };
  }

  // Enhanced project-wide linting with ignore patterns
  async lintProjectWide(options = {}) {
    if (!astGrepAvailable) {
      return {
        available: false,
        mostProblematicFile: null,
        summary: {
          totalIssues: 0,
          filesScanned: 0,
          totalFiles: 0
        }
      };
    }

    const fs = await import('fs');
    const path = await import('path');

    const {
      maxFiles = 200,
      extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
      workingDirectory = this.workingDirectory
    } = options;

    const ignoreInstance = (await import('ignore')).default();
    ignoreInstance.add(universalIgnorePatterns);

    const fileIssues = new Map(); // Map of file path to issues array
    let totalFilesScanned = 0;
    let totalFilesFound = 0;

    const scanDirectory = async (dir, depth = 0) => {
      if (depth > 5 || totalFilesScanned >= maxFiles) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (totalFilesScanned >= maxFiles) break;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Check if directory should be ignored
            if (ignoreInstance.ignores(fullPath)) {
              continue;
            }
            await scanDirectory(fullPath, depth + 1);
          } else if (entry.isFile()) {
            // Check if file should be ignored
            if (ignoreInstance.ignores(fullPath)) {
              continue;
            }

            totalFilesFound++;

            // Only process source code files
            if (extensions.some(ext => fullPath.endsWith(ext))) {
              totalFilesScanned++;

              try {
                const result = await this.lintFile(fullPath);
                if (result.available && result.issues && result.issues.length > 0) {
                  fileIssues.set(fullPath, result.issues);
                }
              } catch (error) {
                // Skip files that can't be linted
                continue;
              }
            }
          }
        }
      } catch (error) {
        // Skip unreadable directories
      }
    };

    await scanDirectory(workingDirectory);

    // Find the file with the most issues
    let mostProblematicFile = null;
    let maxIssues = 0;

    for (const [filePath, issues] of fileIssues.entries()) {
      const issueCount = issues.length;
      if (issueCount > maxIssues) {
        maxIssues = issueCount;
        mostProblematicFile = {
          path: filePath,
          issues: issues,
          issueCount: issueCount,
          errorCount: issues.filter(i => i.severity === 'error').length,
          warningCount: issues.filter(i => i.severity === 'warning').length,
          infoCount: issues.filter(i => i.severity === 'info').length
        };
      }
    }

    const totalIssues = Array.from(fileIssues.values()).flat().length;

    return {
      available: true,
      mostProblematicFile,
      summary: {
        totalIssues,
        filesScanned: totalFilesScanned,
        totalFiles: totalFilesFound,
        filesWithIssues: fileIssues.size
      }
    };
  }

  // Format the most problematic file report
  formatMostProblematicFileReport(mostProblematicFile, summary) {
    if (!mostProblematicFile) {
      return summary.totalFiles > 0 ?
        '✅ Project-wide linting: No issues found across all source files' :
        'ℹ️ Project-wide linting: No source files found to analyze';
    }

    const relativePath = mostProblematicFile.path.replace(process.cwd() + '/', '');

    let report = `🔍 Project-wide Linting Report:\n`;
    report += `📁 Files scanned: ${summary.filesScanned}/${summary.totalFiles}\n`;
    report += `📊 Files with issues: ${summary.filesWithIssues}\n`;
    report += `🚨 Total issues found: ${summary.totalIssues}\n\n`;

    report += `🎯 Most Problematic File: ${relativePath}\n`;
    report += `📊 Issues: ${mostProblematicFile.issueCount} `;
    report += `(🚨 ${mostProblematicFile.errorCount}, ⚠️ ${mostProblematicFile.warningCount}, ℹ️ ${mostProblematicFile.infoCount})\n\n`;

    // Group issues by severity
    const errors = mostProblematicFile.issues.filter(i => i.severity === 'error');
    const warnings = mostProblematicFile.issues.filter(i => i.severity === 'warning');
    const info = mostProblematicFile.issues.filter(i => i.severity === 'info');

    if (errors.length > 0) {
      report += `🚨 Errors (${errors.length}):\n`;
      errors.slice(0, 5).forEach(issue => {
        report += `  Line ${issue.line}: ${issue.message}\n`;
      });
      if (errors.length > 5) {
        report += `  ... and ${errors.length - 5} more errors\n`;
      }
      report += '\n';
    }

    if (warnings.length > 0) {
      report += `⚠️  Warnings (${warnings.length}):\n`;
      warnings.slice(0, 5).forEach(issue => {
        report += `  Line ${issue.line}: ${issue.message}\n`;
      });
      if (warnings.length > 5) {
        report += `  ... and ${warnings.length - 5} more warnings\n`;
      }
      report += '\n';
    }

    if (info.length > 0) {
      report += `ℹ️  Info (${info.length}):\n`;
      info.slice(0, 3).forEach(issue => {
        report += `  Line ${issue.line}: ${issue.message}\n`;
      });
      if (info.length > 3) {
        report += `  ... and ${info.length - 3} more info items\n`;
      }
    }

    return report.trim();
  }

  formatIssues(issues, options = {}) {
    if (!issues || issues.length === 0) {
      return null;
    }

    const { groupBy = 'severity', includePattern = false } = options;

    let output = '';

    if (groupBy === 'severity') {
      const errors = issues.filter(i => i.severity === 'error');
      const warnings = issues.filter(i => i.severity === 'warning');
      const info = issues.filter(i => i.severity === 'info');

      if (errors.length > 0) {
        output += `🚨 Errors (${errors.length}):\n`;
        errors.forEach(issue => {
          output += `  ${issue.file}:${issue.line} - ${issue.message}\n`;
          if (includePattern) {
            output += `    Pattern: ${issue.pattern}\n`;
          }
        });
        output += '\n';
      }

      if (warnings.length > 0) {
        output += `⚠️  Warnings (${warnings.length}):\n`;
        warnings.forEach(issue => {
          output += `  ${issue.file}:${issue.line} - ${issue.message}\n`;
          if (includePattern) {
            output += `    Pattern: ${issue.pattern}\n`;
          }
        });
        output += '\n';
      }

      if (info.length > 0) {
        output += `ℹ️  Info (${info.length}):\n`;
        info.forEach(issue => {
          output += `  ${issue.file}:${issue.line} - ${issue.message}\n`;
          if (includePattern) {
            output += `    Pattern: ${issue.pattern}\n`;
          }
        });
      }
    } else {
      // Group by file
      const grouped = {};
      issues.forEach(issue => {
        if (!grouped[issue.file]) {
          grouped[issue.file] = [];
        }
        grouped[issue.file].push(issue);
      });

      Object.entries(grouped).forEach(([file, fileIssues]) => {
        output += `📄 ${file} (${fileIssues.length} issues):\n`;
        fileIssues.forEach(issue => {
          const icon = issue.severity === 'error' ? '🚨' :
                       issue.severity === 'warning' ? '⚠️' : 'ℹ️';
          output += `  ${icon} Line ${issue.line}: ${issue.message}\n`;
        });
        output += '\n';
      });
    }

    return output.trim();
  }
}

export default ASTLinter;