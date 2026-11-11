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
    return this.invoke<DevkitRunOutput>(['run', ...tasks]);
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
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new Error(
        `kb-devkit ${args[0]} produced non-JSON output (exit ${result.code}). ` +
        `stderr: ${result.stderr.slice(0, 300)}`
      );
    }
  }
}
