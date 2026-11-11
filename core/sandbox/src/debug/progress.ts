/**
 * @module @kb-labs/core-sandbox/debug/progress
 * Progress indicators and streaming log formatting
 */
import { resolveColorSupport } from '@kb-labs/plugin-contracts/color-policy';

/**
 * Progress bar options
 */
export interface ProgressBarOptions {
  /** Total number of items or 100 for percentage */
  total: number;
  /** Current progress */
  current: number;
  /** Bar width in characters */
  width?: number;
  /** Label to display */
  label?: string;
  /** Whether to show percentage */
  showPercentage?: boolean;
}

/**
 * Live metrics
 */
export interface LiveMetrics {
  memory: {
    current: number; // MB
    delta: number; // MB change
  };
  cpu?: number; // Percentage
  operations: {
    fs: number;
    net: number;
    total: number;
  };
}

/**
 * Format progress bar
 */
export function formatProgressBar(options: ProgressBarOptions): string {
  const {
    total,
    current,
    width = 40,
    label = '',
    showPercentage = true,
  } = options;

  const percentage = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const filled = Math.floor((percentage / 100) * width);
  const empty = width - filled;

  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const percentageStr = showPercentage ? ` ${percentage}%` : '';
  const labelStr = label ? `${label} ` : '';

  return `[${bar}]${percentageStr} ${labelStr}`.trim();
}

/**
 * Format live metrics
 */
export function formatLiveMetrics(metrics: LiveMetrics): string {
  const parts: string[] = [];

  // Memory
  const memorySign = metrics.memory.delta >= 0 ? '+' : '';
  parts.push(`Memory: ${metrics.memory.current}MB (${memorySign}${metrics.memory.delta}MB)`);

  // CPU
  if (metrics.cpu !== undefined) {
    parts.push(`CPU: ${metrics.cpu}%`);
  }

  // Operations
  if (metrics.operations.total > 0) {
    const opsParts: string[] = [];
    if (metrics.operations.fs > 0) {
      opsParts.push(`${metrics.operations.fs} fs`);
    }
    if (metrics.operations.net > 0) {
      opsParts.push(`${metrics.operations.net} net`);
    }
    if (opsParts.length > 0) {
      parts.push(`Operations: ${opsParts.join(', ')}`);
    }
  }

  return parts.join(' | ');
}

/**
 * Color codes for terminal output
 */
export const Colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
} as const;

/**
 * Colorize log level
 */
export function colorizeLevel(level: 'debug' | 'info' | 'warn' | 'error'): string {
  switch (level) {
    case 'error':
      return `${Colors.red}${level.toUpperCase()}${Colors.reset}`;
    case 'warn':
      return `${Colors.yellow}${level.toUpperCase()}${Colors.reset}`;
    case 'info':
      return `${Colors.green}${level.toUpperCase()}${Colors.reset}`;
    case 'debug':
      return `${Colors.cyan}${level.toUpperCase()}${Colors.reset}`;
    default:
      // All cases are handled, but TypeScript needs this for exhaustiveness
      return String(level).toUpperCase();
  }
}

/**
 * Format log line with colors and timestamp
 */
export function formatLogLine(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  namespace?: string,
  timestamp?: Date
): string {
  const timeStr = timestamp
    ? `[${timestamp.toISOString()}]`
    : `[${new Date().toISOString()}]`;
  const levelStr = colorizeLevel(level);
  const namespaceStr = namespace ? `[${namespace}]` : '';
  const parts = [timeStr, levelStr, namespaceStr, message].filter(Boolean);
  return parts.join(' ');
}

/**
 * Check the shared host color policy for this process's stdout.
 */
export function shouldUseColors(): boolean {
  return resolveColorSupport(process.stdout.isTTY, process.env.NO_COLOR, process.env.FORCE_COLOR, process.env.TERM);
}

/**
 * Strip ANSI color codes from string
 */
export function stripColors(str: string): string {
   
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

