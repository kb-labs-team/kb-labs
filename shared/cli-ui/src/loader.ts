/**
 * Progress indicators and loaders for CLI operations
 *
 * Periodic animation implementation (works in child processes as multi-line output).
 */

import { safeColors, safeSymbols } from './colors';
function writeOutput(text: string, jsonMode = false): void {
  if (jsonMode) {return;}
  process.stdout.write(text);
}

let _jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  _jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return _jsonMode;
}

export interface LoaderOptions {
  /** Text to show while loading */
  text?: string;
  /** Whether to show spinner (true) or progress bar (false) */
  spinner?: boolean;
  /** Total items for progress bar */
  total?: number;
  /** Current item for progress bar */
  current?: number;
  /** Route human progress to stderr for machine-readable command output. */
  jsonMode?: boolean;
}

const SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Loader {
  private isActive = false;
  private options: LoaderOptions;
  private frameIndex = 0;
  private intervalId?: NodeJS.Timeout;
  private currentText: string;  // ← Реактивная переменная для текста

  constructor(options: LoaderOptions = {}) {
    this.options = {
      text: 'Loading...',
      spinner: true,
      ...options,
    };
    this.currentText = this.options.text ?? 'Loading...';
  }

  start(): void {
    if (this.isActive) {
      return;
    }
    this.isActive = true;

    // Start periodic animation updates (every 200ms)
    if (this.options.spinner) {
      this.intervalId = setInterval(() => {
        if (!this.isActive) {
          this.clearInterval();
          return;
        }

        const char = SPINNER_CHARS[this.frameIndex % SPINNER_CHARS.length];
        writeOutput(`\r${char} ${this.currentText}`, this.options.jsonMode);
        this.frameIndex++;
      }, 200);
    }
  }

  update(options: Partial<LoaderOptions>): void {
    this.options = { ...this.options, ...options };

    if (!this.isActive) {return;}

    // Update reactive text - setInterval will pick it up on next tick
    if (options.text !== undefined) {
      this.currentText = options.text;
    }

    // For manual updates when no interval (progress bar mode)
    if (!this.intervalId) {
      if (this.options.spinner) {
        const text = this.options.text ?? 'Loading...';
        writeOutput(`${safeSymbols.info} ${text}\n`, this.options.jsonMode);
      } else if (this.options.total !== undefined) {
        this.updateProgress();
      }
    }
  }

  stop(): void {
    this.isActive = false;
    this.clearInterval();
  }

  succeed(message?: string): void {
    this.stop();
    if (message) {
      writeOutput(`\r\x1b[K${safeSymbols.success} ${message}\n`, this.options.jsonMode);
    }
  }

  fail(message?: string): void {
    this.stop();
    if (message) {
      writeOutput(`\r\x1b[K${safeSymbols.error} ${message}\n`, this.options.jsonMode);
    }
  }

  private clearInterval(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private updateProgress(): void {
    if (this.options.total === undefined || this.options.current === undefined) {return;}

    const current = this.options.current;
    const total = this.options.total;
    const percentage = Math.round((current / total) * 100);
    const barLength = 20;
    const filledLength = Math.round((current / total) * barLength);

    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
    const text = this.options.text || 'Progress';

    writeOutput(`\r${safeColors.info('→')} ${text}... ${bar} ${percentage}% (${current}/${total})`, this.options.jsonMode);
  }
}

/**
 * Create a simple spinner
 */
export function createSpinner(text: string, jsonMode = false): Loader {
  return new Loader({ text, spinner: true, jsonMode });
}

/**
 * Create a progress bar
 */
export function createProgressBar(text: string, total: number, jsonMode = false): Loader {
  return new Loader({ text, spinner: false, total, current: 0, jsonMode });
}

/**
 * Simple loading message without spinner
 */
export function showLoading(text: string, jsonMode = false): void {
  writeOutput(`${safeColors.info('→')} ${text}...\n`, jsonMode);
}

/**
 * Show completion message
 */
export function showSuccess(text: string, jsonMode = false): void {
  writeOutput(`${safeSymbols.success} ${text}\n`, jsonMode);
}

/**
 * Show error message
 */
export function showError(text: string, jsonMode = false): void {
  writeOutput(`${safeSymbols.error} ${text}\n`, jsonMode);
}

/**
 * Create a loader for progress indication
 *
 * @param text - Text to display while loading
 * @param options - Optional configuration
 * @returns Loader instance
 *
 * @example
 * ```typescript
 * import { useLoader } from '@kb-labs/sdk';
 *
 * const loader = useLoader('Processing data...');
 * loader.start();
 * // ... do work ...
 * loader.succeed('Processing complete!');
 * ```
 */
export function useLoader(text: string, options?: Partial<LoaderOptions>): Loader {
  return new Loader({ text, jsonMode: _jsonMode, ...options });
}
