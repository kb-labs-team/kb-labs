import type { ShellAPI } from '@kb-labs/sdk';
import type {
  DevkitRunOutput,
  DevkitCheckOutput,
  DevkitStatsOutput,
  DevkitStatusOutput,
  DevkitGateOutput,
} from '../../contracts/index.js';

export interface DevkitAdapterOptions {
  binaryPath: string;
  cwd: string;
  shell: ShellAPI;
  timeoutMs?: number;
}

export class DevkitAdapter {
  private readonly bin: string;
  private readonly cwd: string;
  private readonly shell: ShellAPI;
  private readonly timeout: number;

  constructor(opts: DevkitAdapterOptions) {
    this.bin = opts.binaryPath;
    this.cwd = opts.cwd;
    this.shell = opts.shell;
    this.timeout = opts.timeoutMs ?? 600_000;
  }

  async run(tasks: string[]): Promise<DevkitRunOutput> {
    if (tasks.length === 0) {throw new Error('DevkitAdapter.run: tasks must not be empty');}
    const response = await this.execute(['run', ...tasks]);
    const envelope = unwrapCliResponse(response.stdout, response.code, response.stderr, 'run');
    const data = envelope.data;
    if (!isRecord(data) || !Array.isArray(data.results) || !isRecord(data.summary) || typeof data.elapsed !== 'string') {
      throw new Error('kb-devkit run returned an invalid result payload: expected elapsed, results, and summary.');
    }

    const results = data.results.map((value) => {
      if (!isRecord(value) || typeof value.Package !== 'string' || typeof value.Task !== 'string' || typeof value.OK !== 'boolean') {
        throw new Error('kb-devkit run returned an invalid task result.');
      }
      return {
        Package: value.Package,
        Task: value.Task,
        OK: value.OK,
        Cached: value.Cached === true,
        Elapsed: typeof value.Elapsed === 'number' ? value.Elapsed : 0,
        ExitCode: typeof value.ExitCode === 'number' ? value.ExitCode : (value.OK ? 0 : 1),
        Stdout: typeof value.Stdout === 'string' ? value.Stdout : '',
        Stderr: typeof value.Stderr === 'string' ? value.Stderr : '',
        Error: typeof value.Error === 'string' ? value.Error : '',
      };
    });

    const summary = data.summary;
    const scheduled = numberOrZero(summary.scheduled);
    const raw: DevkitRunOutput = {
      elapsed: data.elapsed,
      ok: envelope.ok,
      results,
      summary: {
        scheduled,
        total: scheduled,
        passed: numberOrZero(summary.passed),
        failed: numberOrZero(summary.failed),
        cached: numberOrZero(summary.cached),
        blocked: numberOrZero(summary.blocked),
        notAffected: numberOrZero(summary.notAffected),
        skippedManual: numberOrZero(summary.skippedManual),
        blockedTasks: Array.isArray(summary.blockedTasks) ? summary.blockedTasks.filter(isBlockedTask) : [],
      },
    };

    if (tasks.includes('test') && !results.some((item) => item.Task === 'test')) {
      throw new Error('kb-devkit run produced no test task results; refusing to report a green QA run.');
    }
    return raw;
  }

  async check(): Promise<DevkitCheckOutput> {
    return this.invoke<DevkitCheckOutput>(['check']);
  }

  async stats(): Promise<DevkitStatsOutput> {
    return this.invoke<DevkitStatsOutput>(['stats']);
  }

  async status(): Promise<DevkitStatusOutput> {
    return this.invoke<DevkitStatusOutput>(['status']);
  }

  async gate(): Promise<DevkitGateOutput> {
    return this.invoke<DevkitGateOutput>(['gate']);
  }

  async version(): Promise<string> {
    const result = await this.shell.exec(this.bin, ['--version'], {
      cwd: this.cwd,
      timeout: 5_000,
      throwOnError: false,
    });
    if (!result.ok) {
      throw new Error(
        `kb-devkit not found or not executable at "${this.bin}". ` +
        `Set QAPluginConfig.devkitPath or ensure kb-devkit is on PATH.`
      );
    }
    return result.stdout.trim();
  }

  private async invoke<T>(args: string[]): Promise<T> {
    const response = await this.execute(args);
    const envelope = unwrapCliResponse(response.stdout, response.code, response.stderr, args[0] ?? 'command');
    const data = envelope.data;
    if (!isRecord(data)) {
      throw new Error(`kb-devkit ${args[0]} returned an invalid JSON payload.`);
    }
    return { ...data, ok: envelope.ok } as T;
  }

  private async execute(args: string[]): Promise<{ stdout: string; stderr: string; code: number; ok: boolean }> {
    const result = await this.shell.exec(this.bin, [...args, '--json'], {
      cwd: this.cwd,
      timeout: this.timeout,
      throwOnError: false,
    });

    if (!result.stdout.trim()) {
      throw new Error(
        `kb-devkit ${args[0]} failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`
      );
    }

    try {
      return { stdout: result.stdout, stderr: result.stderr, code: result.code, ok: result.ok };
    } catch {
      throw new Error(
        `kb-devkit ${args[0]} produced non-JSON output (exit ${result.code}). ` +
        `stderr: ${result.stderr.slice(0, 300)}`
      );
    }
  }
}

interface CliResponse {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; hint?: string };
}

function unwrapCliResponse(stdout: string, code: number, stderr: string, command: string): { ok: boolean; data: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(
      `kb-devkit ${command} produced non-JSON output (exit ${code}). stderr: ${stderr.slice(0, 300)}`
    );
  }
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw new Error(`kb-devkit ${command} returned an invalid CliKit response.`);
  }
  const response = parsed as unknown as CliResponse;
  if (response.ok !== (code === 0)) {
    throw new Error(`kb-devkit ${command} returned ok:${response.ok} with exit ${code}; refusing to trust inconsistent output.`);
  }
  if (!response.ok && !('data' in response)) {
    const error = response.error;
    const message = error?.message ?? `kb-devkit ${command} failed (exit ${code}).`;
    const hint = error?.hint ? ` Hint: ${error.hint}` : '';
    throw new Error(`${message}${hint}`);
  }
  if (!('data' in response)) {
    throw new Error(`kb-devkit ${command} response is missing data.`);
  }
  return { ok: response.ok, data: response.data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isBlockedTask(value: unknown): value is DevkitRunOutput['summary']['blockedTasks'][number] {
  return isRecord(value) && typeof value.package === 'string' && typeof value.task === 'string' &&
    typeof value.blockedByPackage === 'string' && typeof value.blockedByTask === 'string';
}
