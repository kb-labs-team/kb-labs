/**
 * Secrets detection module
 * Detects files that likely contain secrets and should not be sent to LLM
 */

import { minimatch } from "minimatch";

/**
 * Custom error class for secrets detection
 * This error should NEVER be caught and fallback to heuristics
 */
export class SecretsDetectedError extends Error {
  public readonly secretMatches: SecretMatch[];

  constructor(matches: SecretMatch[], message: string) {
    super(message);
    this.name = 'SecretsDetectedError';
    this.secretMatches = matches;

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SecretsDetectedError);
    }
  }
}

/**
 * Structural check for SecretsDetectedError, safe across subpath-export
 * boundaries (`./analyzer` vs `./generator`). tsup bundles each entry
 * independently, so `error instanceof SecretsDetectedError` fails when the
 * throw site and the catch site pull the class from different subpaths —
 * they end up with two distinct class objects despite identical source.
 */
export function isSecretsDetectedError(error: unknown): error is SecretsDetectedError {
  return (
    error instanceof Error &&
    error.name === 'SecretsDetectedError' &&
    Array.isArray((error as SecretsDetectedError).secretMatches)
  );
}

/**
 * Detailed information about a detected secret
 */
export interface SecretMatch {
  file: string;
  line: number;
  column: number;
  pattern: string; // Which pattern matched
  patternName: string; // Human-readable pattern name
  snippet: string; // Code snippet (with context)
  matchedText: string; // The actual matched text (truncated if long)
}

/**
 * File patterns that likely contain secrets
 * Based on common secret file conventions
 */
const SECRET_FILE_PATTERNS = [
  // Environment files
  ".env",
  ".env.*",
  "*.env",
  ".envrc",

  // NPM/Node
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",

  // SSH/GPG keys
  "*.key",
  "*.pem",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*.pub",

  // AWS
  ".aws/**",
  "credentials",

  // Docker
  ".docker/config.json",

  // Git credentials
  ".git-credentials",
  ".netrc",

  // Service account files
  "*-service-account.json",
  "*-serviceaccount.json",
  "service-account*.json",
  "serviceaccount*.json",

  // Kubernetes
  "kubeconfig",
  "*.kubeconfig",

  // Terraform
  "*.tfvars",
  "terraform.tfstate",
  "terraform.tfstate.backup",

  // Other common secrets
  "secrets.yml",
  "secrets.yaml",
  "secret.yml",
  "secret.yaml",
  "passwords.txt",
  "password.txt",
];

/**
 * Content patterns that indicate secrets (with human-readable names)
 */
const SECRET_CONTENT_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  // API keys/tokens
  { pattern: /api[_-]?key[s]?['":\s]*[a-zA-Z0-9_-]{20,}/i, name: 'API Key' },
  { pattern: /auth[_-]?token[s]?['":\s]*[a-zA-Z0-9_-]{20,}/i, name: 'Auth Token' },
  { pattern: /access[_-]?token[s]?['":\s]*[a-zA-Z0-9_-]{20,}/i, name: 'Access Token' },

  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/, name: 'AWS Access Key ID' },
  { pattern: /aws[_-]?secret[_-]?access[_-]?key/i, name: 'AWS Secret Access Key' },

  // NPM
  { pattern: /\/\/registry\.npmjs\.org\/:_authToken=/, name: 'NPM Auth Token' },
  { pattern: /npm_[A-Za-z0-9]{30,}/, name: 'NPM Token' },

  // GitHub
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/, name: 'GitHub Token' },

  // Slack
  { pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}/, name: 'Slack Token' },

  // Private keys
  { pattern: /-----BEGIN (RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----/, name: 'Private Key' },

  // Passwords
  { pattern: /password['":\s]*['"]/i, name: 'Password' },

  // Generic patterns
  { pattern: /secret['":\s]*['"]/i, name: 'Secret' },
];

/**
 * Check if file path matches secret file patterns
 */
export function isSecretFile(filePath: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, "/");

  return SECRET_FILE_PATTERNS.some((pattern) =>
    minimatch(normalizedPath, pattern, { matchBase: true }),
  );
}

/**
 * Check if file content contains secret patterns
 */
export function containsSecrets(content: string): boolean {
  return SECRET_CONTENT_PATTERNS.some(({ pattern }) => pattern.test(content));
}

/**
 * Scan files for potential secrets
 * Returns list of files that likely contain secrets
 */
export function detectSecretFiles(files: string[]): string[] {
  return files.filter(isSecretFile);
}

/**
 * Scan file diffs for secrets
 * Returns map of files that contain secrets
 */
export function detectSecretsInDiffs(
  diffs: Map<string, string>,
): Map<string, string> {
  const secretDiffs = new Map<string, string>();

  for (const [file, diff] of diffs.entries()) {
    if (containsSecrets(diff)) {
      secretDiffs.set(file, diff);
    }
  }

  return secretDiffs;
}

/**
 * Create error message for detected secrets
 */
export function formatSecretsWarning(secretFiles: string[]): string {
  const count = secretFiles.length;
  const filesList = secretFiles.map((f) => `  - ${f}`).join("\n");

  return [
    `🚨 CRITICAL SECURITY ERROR: Detected ${count} file(s) with potential secrets:`,
    filesList,
    "",
    "⛔️ COMMIT GENERATION ABORTED",
    "",
    "These files contain sensitive data (API keys, tokens, credentials)",
    "that MUST NOT be committed to git or sent to LLM.",
    "",
    "✅ Actions to fix:",
    "  1. Add these files to .gitignore",
    "  2. Remove secrets from the files (use environment variables instead)",
    "  3. If already committed, use git filter-branch or BFG to remove from history",
    "",
    "⚠️  If you already ran commit:generate before, the secrets may have been",
    "sent to OpenAI. Rotate your credentials immediately.",
  ].join("\n");
}

/**
 * Detect secrets in file diffs with exact location information
 * Returns array of SecretMatch with file, line, column, pattern info
 */
export function detectSecretsWithLocation(
  diffs: Map<string, string>,
): SecretMatch[] {
  const matches: SecretMatch[] = [];

  for (const [file, diff] of diffs.entries()) {
    const lines = diff.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? '';

      for (const { pattern, name } of SECRET_CONTENT_PATTERNS) {
        // Reset regex lastIndex for global patterns
        pattern.lastIndex = 0;

        const match = pattern.exec(line);
        if (match) {
          const matchedText = match[0];
          const column = match.index;

          // Create snippet with context (20 chars before, full match, 20 chars after)
          const snippetStart = Math.max(0, column - 20);
          const snippetEnd = Math.min(line.length, column + matchedText.length + 20);
          const snippet = line.substring(snippetStart, snippetEnd);

          // Truncate matched text if very long (max 50 chars)
          const displayText = matchedText.length > 50
            ? matchedText.substring(0, 50) + '...'
            : matchedText;

          matches.push({
            file,
            line: lineIndex + 1, // 1-based line numbers
            column: column + 1, // 1-based column numbers
            pattern: pattern.source,
            patternName: name,
            snippet: snippet.trim(),
            matchedText: displayText,
          });
        }
      }
    }
  }

  return matches;
}

/**
 * Format detailed secrets report with locations
 */
export function formatSecretsReport(matches: SecretMatch[]): string {
  const count = matches.length;
  const fileCount = new Set(matches.map(m => m.file)).size;

  const lines = [
    `🚨 CRITICAL SECURITY ERROR: Detected ${count} potential secret(s) in ${fileCount} file(s)`,
    "",
    "⛔️ COMMIT GENERATION BLOCKED",
    "",
  ];

  // Group by file
  const byFile = new Map<string, SecretMatch[]>();
  for (const match of matches) {
    const existing = byFile.get(match.file) ?? [];
    existing.push(match);
    byFile.set(match.file, existing);
  }

  // Format each file's matches
  for (const [file, fileMatches] of byFile.entries()) {
    lines.push(`📄 ${file}:`);
    for (const match of fileMatches) {
      lines.push(`  Line ${match.line}:${match.column} - ${match.patternName}`);
      lines.push(`    Pattern: ${match.pattern.substring(0, 60)}${match.pattern.length > 60 ? '...' : ''}`);
      lines.push(`    Matched: ${match.matchedText}`);
      lines.push(`    Context: ...${match.snippet}...`);
      lines.push('');
    }
  }

  lines.push(
    "🔒 These files contain sensitive data (API keys, tokens, credentials)",
    "that MUST NOT be committed to git or sent to LLM.",
    "",
    "✅ Actions to fix:",
    "  1. Review each match above - some may be false positives (e.g., examples in comments)",
    "  2. If real secrets: Add files to .gitignore and remove secrets (use env vars)",
    "  3. If false positives: Use --allow-secrets flag to proceed with confirmation",
    "",
    "⚠️  If secrets were already sent to LLM in previous runs, rotate credentials immediately!",
  );

  return lines.join("\n");
}
