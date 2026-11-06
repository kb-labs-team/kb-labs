import { box, keyValue, safeKeyValue, hasAnsi } from './format';
import { formatTiming } from './command-output';
import { safeColors, safeSymbols } from './colors';
import {
  displayArtifacts,
  type ArtifactInfo,
  type ArtifactDisplayOptions,
} from './artifacts-display';
import { TimingTracker } from './timing-tracker';

export interface CommandPresenter {
  info(message: string): void;
  warn?(message: string): void;
  error(message: string): void;
  write(payload: string): void;
  json(payload: unknown): void;
}

export interface CommandContext {
  cwd: string;
  presenter: CommandPresenter;
}

export interface CommandExecutionResult {
  summary: Record<string, string | number>;
  artifacts?: ArtifactInfo[];
  artifactsOptions?: ArtifactDisplayOptions;
  timing?: number | Record<string, number>;
  diagnostics?: string[];
  warnings?: string[];
  errors?: string[];
  data?: Record<string, unknown>;
}

export interface CommandRunnerOptions {
  title: string;
  execute: (ctx: CommandContext, flags: Record<string, unknown>, tracker: TimingTracker) => Promise<CommandExecutionResult>;
}

export function createCommandRunner(options: CommandRunnerOptions) {
  return async (ctx: CommandContext, argv: string[], flags: Record<string, unknown>): Promise<number> => {
    const tracker = new TimingTracker();
    const jsonMode = flags.json === true;
    const quietMode = flags.quiet === true;
    const execute = async (): Promise<number> => {
      tracker.checkpoint('start');
      try {
        const result = await options.execute(ctx, flags, tracker);
        tracker.checkpoint('complete');
        formatSuccessOutput(ctx, options.title, result, tracker.total(), {
          jsonMode,
          quietMode,
        });
        return 0;
      } catch (error) {
        tracker.checkpoint('error');
        const message = error instanceof Error ? error.message : String(error);
        formatErrorOutput(ctx, message, tracker.total(), {
          jsonMode,
          quietMode,
        });
        return 1;
      }
    };
    return execute();
  };
}

interface OutputFlags {
  jsonMode: boolean;
  quietMode: boolean;
}

function formatSuccessOutput(
  ctx: CommandContext,
  title: string,
  result: CommandExecutionResult,
  durationMs: number,
  flags: OutputFlags,
): void {
  if (flags.jsonMode) {
    const payload: Record<string, unknown> = {
      ok: true,
      summary: result.summary,
      timing: result.timing ?? durationMs,
      diagnostics: result.diagnostics,
      warnings: result.warnings,
      errors: result.errors,
    };
    if (result.artifacts) {
      payload.artifacts = result.artifacts;
    }
    if (result.data) {
      Object.assign(payload, result.data);
    }
    ctx.presenter.json(payload);
    return;
  }

  if (flags.quietMode) {
    return;
  }

  const statusEntry = extractStatusEntry(result.summary);
  const summaryForDisplay: Record<string, string | number> = statusEntry
    ? { ...result.summary }
    : result.summary;

  if (statusEntry) {
    delete summaryForDisplay[statusEntry.key];
  }

  const lines: string[] = [];
  const summaryLines = keyValue(summaryForDisplay);
  if (summaryLines.length > 0) {
    lines.push(...summaryLines);
  }

  if (result.artifacts && result.artifacts.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(...displayArtifacts(result.artifacts, result.artifactsOptions));
  }

  const timing = result.timing ?? durationMs;
  if (typeof timing !== 'number') {
    const entries = Object.entries(timing);
    if (entries.length > 0) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(safeColors.bold('Timing'));
      for (const [label, value] of entries) {
        lines.push(...safeKeyValue({ [label]: formatTiming(value) }, { indent: 2, pad: false }));
      }
    }
  }

  if (result.diagnostics && result.diagnostics.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(safeColors.bold('Diagnostics'));
    result.diagnostics.forEach((item) => lines.push(safeColors.muted(`- ${item}`)));
  }

  if (result.warnings && result.warnings.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(safeColors.bold('Warnings'));
    result.warnings.forEach((item) => lines.push(safeColors.muted(`- ${item}`)));
  }

  if (result.errors && result.errors.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(safeColors.bold('Errors'));
    result.errors.forEach((item) => lines.push(safeColors.muted(`- ${item}`)));
  }

  if (lines.length > 0) {
    lines.push('');
  }
  lines.push(formatStatusLine(statusEntry?.value, durationMs));

  ctx.presenter.write(box(title, lines));
}

function formatErrorOutput(
  ctx: CommandContext,
  errorMessage: string,
  durationMs: number,
  flags: OutputFlags,
): void {
  if (flags.jsonMode) {
    ctx.presenter.json({
      ok: false,
      error: errorMessage,
      timing: durationMs,
    });
    return;
  }

  if (flags.quietMode) {
    return;
  }

  ctx.presenter.error(errorMessage);
}

interface StatusEntry {
  key: string;
  value: string;
}

function extractStatusEntry(summary: Record<string, string | number>): StatusEntry | null {
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === 'string' && key.toLowerCase().includes('status')) {
      return { key, value };
    }
  }
  return null;
}

function formatStatusLine(statusValue: string | undefined, durationMs: number): string {
  const rawStatus = statusValue ?? 'Done';
  const normalized = rawStatus.toLowerCase();

  let symbol = safeSymbols.success;
  let colorize = safeColors.success;

  if (normalized.includes('error') || normalized.includes('fail')) {
    symbol = safeSymbols.error;
    colorize = safeColors.error;
  } else if (normalized.includes('partial') || normalized.includes('warn')) {
    symbol = safeSymbols.warning;
    colorize = safeColors.warning;
  }

  const statusText = hasAnsi(rawStatus) ? rawStatus : colorize(rawStatus);
  return `${symbol} ${statusText} · ${safeColors.muted(formatTiming(durationMs))}`;
}

