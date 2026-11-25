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

export class NoDevkitTasksSelectedError extends Error {
  readonly code = 'KB_RUNTIME_INPUT_INVALID';

  constructor(tasks: string[], packages: string[]) {
    const scope = packages.length > 0 ? `packages ${packages.join(', ')}` : 'the selected workspace scope';
    super(`No DevKit tasks were selected for ${scope} and tasks ${tasks.join(', ')}.`);
    this.name = 'NoDevkitTasksSelectedError';
  }
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

  async run(tasks: string[], packages?: string): Promise<DevkitRunOutput> {
    if (tasks.length === 0) {throw new Error('DevkitAdapter.run: tasks must not be empty');}
    const packageSelector = packages?.trim();
    const packageNames = packageSelector ? packageSelector.split(',').map((name) => name.trim()) : [];
    if (packageSelector && packageNames.some((name) => !name)) {
      throw new Error('DevkitAdapter.run: packages must include at least one name per selector entry');
    }
    const packageArgs = packageNames.length > 0 ? ['--packages', packageNames.join(',')] : [];
    const output = await this.invoke<DevkitRunOutput>(['run', ...tasks, ...packageArgs]);
    if (output.ok === false) {
      const failure = (output as DevkitRunOutput & { error?: { code?: string; message?: string; hint?: string } }).error;
      if (failure && typeof failure.message === 'string') {
        throw Object.assign(new Error(failure.message), {
          ...(failure.code ? { code: failure.code } : {}),
          ...(failure.hint ? { hint: failure.hint } : {}),
        });
      }
    }
    const selectedTaskCount = output.summary?.scheduled ?? output.summary?.total;
    if (selectedTaskCount === undefined || !Number.isInteger(selectedTaskCount) || selectedTaskCount <= 0) {
      throw new NoDevkitTasksSelectedError(tasks, packageNames);
    }
    const results = Array.isArray(output.results) ? output.results : [];
    const selectedResults = results.filter((result) =>
      tasks.includes(result.Task)
      && (packageNames.length === 0 || packageNames.includes(result.Package))
    );
    if (selectedResults.length === 0) {
      throw new NoDevkitTasksSelectedError(tasks, packageNames);
    }
    return {
      ...output,
      summary: { ...output.summary, scheduled: selectedTaskCount },
    };
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
    const result = await this.shell.exec(this.bin, [...args, '--json'], {
      cwd: this.cwd,
      timeout: this.timeout,
      throwOnError: false,
    });

    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error(
        `kb-devkit ${args[0]} failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`
      );
    }

    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (parsed !== null && typeof parsed === 'object' && 'data' in parsed) {
        const data = (parsed as { data?: unknown }).data;
        if (data !== null && typeof data === 'object') {
          const envelopeOk = (parsed as { ok?: unknown }).ok;
          if (typeof envelopeOk === 'boolean' && !('ok' in data)) {
            return { ...data, ok: envelopeOk } as T;
          }
          return data as T;
        }
      }
      return parsed as T;
    } catch {
      throw new Error(
        `kb-devkit ${args[0]} produced non-JSON output (exit ${result.code}). ` +
        `stderr: ${result.stderr.slice(0, 300)}`
      );
    }
  }
}
