/**
 * Privacy redaction for trace events
 *
 * Uses shallow clone optimization - only clones objects that need redaction,
 * not the entire trace event tree.
 */

import type { DetailedTraceEntry } from '../contracts/index.js';
import type { TraceConfig } from './incremental-trace-writer.js';

/**
 * Default secret patterns (regex)
 */
const DEFAULT_SECRET_PATTERNS = [
  // API keys
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI API keys
  /sk_live_[A-Za-z0-9]{24,}/g, // Stripe API keys
  /ghp_[A-Za-z0-9]{36}/g, // GitHub personal access tokens

  // Authentication tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /token[=:]\s*[A-Za-z0-9\-._~+/]+=*/gi,

  // Passwords
  /password[=:]\s*["']?[^"'\s]+["']?/gi,
  /passwd[=:]\s*["']?[^"'\s]+["']?/gi,
  /pwd[=:]\s*["']?[^"'\s]+["']?/gi,

  // Connection strings
  /mongodb(\+srv)?:\/\/[^@]+@[^\s]+/g,
  /postgres(ql)?:\/\/[^@]+@[^\s]+/g,
  /mysql:\/\/[^@]+@[^\s]+/g,

  // Email addresses (PII)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,

  // Note: Generic long alphanumeric pattern removed to avoid false positives
  // (would match file hashes, UUIDs, legitimate data)
  // Credit card numbers removed - too many false positives
];

/**
 * Redact secrets from a string
 */
export function redactSecretsFromString(
  str: string,
  patterns: RegExp[] = DEFAULT_SECRET_PATTERNS
): string {
  let result = str;

  for (const pattern of patterns) {
    result = result.replace(pattern, '[REDACTED]');
  }

  return result;
}

/**
 * Redact file paths (replace absolute paths with relative)
 */
export function redactPaths(
  str: string,
  replacements: Record<string, string>
): string {
  let result = str;

  // Apply custom replacements
  for (const [absolute, relative] of Object.entries(replacements)) {
    result = result.replace(new RegExp(absolute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), relative);
  }

  return result;
}

/**
 * Redact secrets from unknown value (recursive shallow clone)
 *
 * Only clones objects/arrays that contain secrets.
 * Primitives and clean objects are returned as-is (no clone).
 */
export function redactValue(
  value: unknown,
  config: TraceConfig['privacy'],
  depth = 0
): unknown {
  // Prevent infinite recursion
  if (depth > 10) {
    return '[REDACTED:TOO_DEEP]';
  }

  // Primitives
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    let result = value;

    if (config.redactSecrets) {
      const patterns = config.secretPatterns.map(p => new RegExp(p, 'g'));
      result = redactSecretsFromString(result, [...DEFAULT_SECRET_PATTERNS, ...patterns]);
    }

    if (config.redactPaths) {
      result = redactPaths(result, config.pathReplacements);
    }

    // Return original if nothing changed (no clone)
    return result === value ? value : result;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  // Arrays - shallow clone only if contains secrets
  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => {
      const redacted = redactValue(item, config, depth + 1);
      if (redacted !== item) {
        changed = true;
      }
      return redacted;
    });

    // Return original if nothing changed (no clone)
    return changed ? result : value;
  }

  // Objects - shallow clone only if contains secrets
  if (typeof value === 'object') {
    let changed = false;
    const result: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(value)) {
      const redacted = redactValue(val, config, depth + 1);
      result[key] = redacted;
      if (redacted !== val) {
        changed = true;
      }
    }

    // Return original if nothing changed (no clone)
    return changed ? result : value;
  }

  return value;
}

/**
 * Redact secrets from a trace event (shallow clone optimization)
 *
 * Only clones parts of the event that need redaction.
 * Returns original event if no redaction needed.
 */
export function redactTraceEvent(
  event: DetailedTraceEntry,
  config: TraceConfig['privacy']
): DetailedTraceEntry {
  // Skip if redaction disabled
  if (!config.redactSecrets && !config.redactPaths) {
    return event;
  }

  // Check if event needs redaction
  // Limit string size to prevent ReDoS (Regular Expression Denial of Service)
  const eventStr = JSON.stringify(event);
  const MAX_STRING_SIZE = 100000; // 100KB limit for regex testing
  const testStr = eventStr.length > MAX_STRING_SIZE ? eventStr.substring(0, MAX_STRING_SIZE) : eventStr;
  let needsRedaction = false;

  if (config.redactSecrets) {
    const patterns = config.secretPatterns.map(p => new RegExp(p, 'g'));
    needsRedaction = [...DEFAULT_SECRET_PATTERNS, ...patterns].some(p => p.test(testStr));
  }

  if (!needsRedaction && config.redactPaths) {
    needsRedaction = Object.keys(config.pathReplacements).some(path => testStr.includes(path));
  }

  // Return original if no secrets found (no clone!)
  if (!needsRedaction) {
    return event;
  }

  // Shallow clone and redact recursively
  return redactValue(event, config, 0) as DetailedTraceEntry;
}

/**
 * Create default privacy config
 */
export function createDefaultPrivacyConfig(): TraceConfig['privacy'] {
  return {
    redactSecrets: true,
    redactPaths: true,
    secretPatterns: [],
    pathReplacements: {
      '/Users': '~',
      '/home': '~',
      'C:\\Users': '~',
    },
  };
}
