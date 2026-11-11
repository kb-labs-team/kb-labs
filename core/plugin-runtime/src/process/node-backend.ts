import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type {
  GovernedProcessRequest,
  IProcessExecutor,
  ProcessBackendCapabilities,
  ProcessResult,
  ProcessTerminationReason,
  ProcessUsage,
} from '@kb-labs/core-platform/adapters';
import type { ILogger } from '@kb-labs/core-platform/adapters';
import { GovernedProcessError, type GovernedProcessLimit } from './errors.js';

interface ProcessSnapshot { cpuMs: number; memoryMb: number; processCount: number; }

function processTerminationError(
  reason: Exclude<ProcessTerminationReason, 'completed'>,
  request: GovernedProcessRequest,
  result: ProcessResult,
  maxOutputBytes: number,
): GovernedProcessError {
  const { usage } = result;
  switch (reason) {
    case 'timeout':
      return new GovernedProcessError('PROCESS_TIMEOUT', `Process terminated: ${reason}`, { result }, {
        resource: 'time (ms)', observed: usage.wallTimeMs, allowed: request.limits.timeoutMs,
      });
    case 'memory_limit': {
      const allowed = request.limits.memoryMb;
      const limit: GovernedProcessLimit | undefined = allowed === undefined ? undefined : {
        resource: 'memory (MB)', observed: usage.peakMemoryMb, allowed,
      };
      return new GovernedProcessError('PROCESS_MEMORY_LIMIT', `Process terminated: ${reason}`, { result }, limit);
    }
    case 'cpu_limit': {
      const allowed = request.limits.cpuMs;
      const limit: GovernedProcessLimit | undefined = allowed === undefined ? undefined : {
        resource: 'CPU time (ms)', observed: usage.cpuMs, allowed,
      };
      return new GovernedProcessError('PROCESS_CPU_LIMIT', `Process terminated: ${reason}`, { result }, limit);
    }
    case 'process_limit': {
      const allowed = request.limits.maxProcesses;
      const limit: GovernedProcessLimit | undefined = allowed === undefined ? undefined : {
        resource: 'process count', observed: usage.processCount, allowed,
      };
      return new GovernedProcessError('PROCESS_LIMIT', `Process terminated: ${reason}`, { result }, limit);
    }
    case 'output_limit':
      return new GovernedProcessError('PROCESS_OUTPUT_LIMIT', `Process terminated: ${reason}`, { result }, {
        resource: 'captured output (bytes)',
        observed: usage.stdoutBytes + usage.stderrBytes,
        allowed: maxOutputBytes,
      });
    case 'cancelled':
    case 'shutdown':
      return new GovernedProcessError('PROCESS_CANCELLED', `Process terminated: ${reason}`, { result });
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) { return; }
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

export abstract class NodeProcessBackend implements IProcessExecutor {
  protected readonly active = new Set<number>();
  private readonly cancellers = new Map<string, (reason: ProcessTerminationReason) => void>();
  private shuttingDown = false;

  constructor(private readonly logger?: ILogger) {}

  abstract capabilities(): ProcessBackendCapabilities;

  protected abstract configureProcess(pid: number, request: GovernedProcessRequest): () => void;

  private treePids(rootPid: number): number[] {
    if (process.platform !== 'linux') { return [rootPid]; }
    const children = new Map<number, number[]>();
    let entries: string[];
    try { entries = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)); }
    catch { return [rootPid]; }
    for (const entry of entries) {
      const pid = Number(entry);
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const ppid = Number(stat.slice(close + 2).split(' ')[1]);
        const list = children.get(ppid) ?? [];
        list.push(pid);
        children.set(ppid, list);
      } catch { /* process exited during scan */ }
    }
    const result = [rootPid];
    for (let i = 0; i < result.length; i++) {
      result.push(...(children.get(result[i]!) ?? []));
    }
    return result;
  }

  protected snapshot(pid: number): ProcessSnapshot {
    const pids = this.treePids(pid);
    let memoryMb = 0;
    let cpuMs = 0;
    for (const current of pids) {
      if (process.platform !== 'linux') { continue; }
      try {
        const status = readFileSync(`/proc/${current}/status`, 'utf8');
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        memoryMb += rss ? Number(rss[1]) / 1024 : 0;
        const stat = readFileSync(`/proc/${current}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(' ');
        const ticks = Number(fields[11]) + Number(fields[12]);
        cpuMs += (ticks / 100) * 1000;
      } catch { /* process exited during scan */ }
    }
    return { cpuMs, memoryMb, processCount: pids.length };
  }

  async execute(request: GovernedProcessRequest): Promise<ProcessResult> {
    if (this.shuttingDown) {
      throw new GovernedProcessError('PROCESS_CANCELLED', 'Process backend is shutting down');
    }
    const attempts = request.retry?.maxAttempts ?? 1;
    if (attempts > 1 && !request.retry?.idempotent) {
      throw new GovernedProcessError('PROCESS_SPAWN_FAILED', 'Retrying shell commands requires idempotent=true');
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { return await this.runOnce(request, attempt); }
      catch (error) {
        lastError = error;
        if (attempt === attempts) { break; }
        if (!(error instanceof GovernedProcessError) || error.code !== 'PROCESS_SPAWN_FAILED') { break; }
        const base = request.retry?.initialDelayMs ?? 250;
        const max = request.retry?.maxDelayMs ?? 5000;
        const jitter = request.retry?.jitter ?? 0.1;
        const delay = Math.min(max, base * 2 ** (attempt - 1));
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.floor(delay * (1 + Math.random() * jitter)));
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private runOnce(request: GovernedProcessRequest, attempt: number): Promise<ProcessResult> {
    const started = Date.now();
    const processId = request.processId ?? randomUUID();
    this.logger?.info('process.execution.started', {
      component: 'process-executor', operation: 'execute', processId,
      executionId: request.identity.executionId, requestId: request.identity.requestId,
      pluginId: request.identity.pluginId, handlerId: request.identity.handlerId,
      command: request.command, argCount: request.args.length, cwd: request.cwd,
      attempt, limits: request.limits,
    });
    const maxOutput = request.limits.maxOutputBytes ?? 8 * 1024 * 1024;
    const graceMs = request.limits.graceMs ?? 1000;
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(request.command, request.args, {
          cwd: request.cwd,
          env: { ...process.env, ...request.env },
          detached: process.platform === 'darwin' || process.platform === 'linux',
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new GovernedProcessError('PROCESS_SPAWN_FAILED', `Failed to spawn ${request.command}`, { cause: String(error) }));
        return;
      }
      // Attach the error listener before inspecting pid. Node emits ENOENT
      // asynchronously for a missing executable, and leaving that window
      // uncovered turns a governed spawn failure into an uncaught exception.
      child.once('error', (error) => {
        if (!child.pid) {
          this.logger?.error('process.execution.failed', error, {
            component: 'process-executor', operation: 'execute',
            executionId: request.identity.executionId, requestId: request.identity.requestId,
            pluginId: request.identity.pluginId, command: request.command,
          });
          reject(new GovernedProcessError('PROCESS_SPAWN_FAILED', error.message));
        }
      });
      if (!child.pid) { reject(new GovernedProcessError('PROCESS_SPAWN_FAILED', 'Process did not receive a PID')); return; }
      const pid = child.pid;
      this.active.add(pid);
      let cleanupProcessConfig = () => {};
      try {
        cleanupProcessConfig = this.configureProcess(pid, request);
      } catch (error) {
        killTree(child, 'SIGKILL');
        this.active.delete(pid);
        reject(new GovernedProcessError('PROCESS_SPAWN_FAILED', 'Unable to apply process limits', { cause: String(error) }));
        return;
      }
      let stdout = ''; let stderr = ''; let stdoutBytes = 0; let stderrBytes = 0;
      let reason: ProcessTerminationReason = 'completed';
      let peakMemoryMb = 0; let peakCpuMs = 0; let peakProcessCount = 1; let settled = false;

      const finish = (code: number | null, signal?: NodeJS.Signals | null) => {
        if (settled) { return; }
        settled = true; this.active.delete(pid); this.cancellers.delete(processId); cleanupProcessConfig(); clearTimeout(timeout); clearInterval(monitor);
        const usage: ProcessUsage = {
          wallTimeMs: Date.now() - started, cpuMs: peakCpuMs, peakMemoryMb,
          processCount: peakProcessCount, stdoutBytes, stderrBytes,
        };
        const result: ProcessResult = {
          processId, code, signal: signal ?? undefined, stdout, stderr,
          ok: reason === 'completed' && code === 0, terminationReason: reason,
          usage, attempts: attempt,
        };
        this.logger?.info('process.execution.finished', {
          component: 'process-executor', operation: 'execute', processId,
          executionId: request.identity.executionId, requestId: request.identity.requestId,
          pluginId: request.identity.pluginId, command: request.command,
          ok: result.ok, code: result.code, terminationReason: result.terminationReason,
          usage: result.usage, attempts: result.attempts,
        });
        if (reason === 'completed') { resolve(result); return; }
        const terminationReason = reason;
        const governedError = processTerminationError(terminationReason, request, result, maxOutput);
        this.logger?.warn('process.execution.terminated', {
          component: 'process-executor', operation: 'execute', processId,
          executionId: request.identity.executionId, requestId: request.identity.requestId,
          pluginId: request.identity.pluginId, terminationReason: reason, usage,
        });
        reject(governedError);
      };
      const terminate = (next: ProcessTerminationReason) => { if (settled) { return; } reason = next; killTree(child, 'SIGTERM'); setTimeout(() => killTree(child, 'SIGKILL'), graceMs); };
      this.cancellers.set(processId, terminate);
      const timeout = setTimeout(() => terminate('timeout'), request.limits.timeoutMs);
      const monitor = setInterval(() => {
        const sample = this.snapshot(pid);
        peakMemoryMb = Math.max(peakMemoryMb, sample.memoryMb); peakCpuMs = Math.max(peakCpuMs, sample.cpuMs); peakProcessCount = Math.max(peakProcessCount, sample.processCount);
        if (request.limits.memoryMb && sample.memoryMb > request.limits.memoryMb) { terminate('memory_limit'); }
        else if (request.limits.cpuMs && sample.cpuMs > request.limits.cpuMs) { terminate('cpu_limit'); }
        else if (request.limits.maxProcesses && sample.processCount > request.limits.maxProcesses) { terminate('process_limit'); }
      }, 50);
      const abort = () => terminate('cancelled');
      request.signal?.addEventListener('abort', abort, { once: true });
      const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        if (stream === 'stdout') { stdoutBytes += chunk.byteLength; stdout += chunk.toString(); }
        else { stderrBytes += chunk.byteLength; stderr += chunk.toString(); }
        if (stdoutBytes + stderrBytes > maxOutput) { terminate('output_limit'); }
      };
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.once('error', (error) => {
        if (!settled) {
          this.logger?.error('process.execution.failed', error, {
            component: 'process-executor', operation: 'execute', processId,
            executionId: request.identity.executionId, requestId: request.identity.requestId,
            pluginId: request.identity.pluginId, command: request.command,
          });
          reject(new GovernedProcessError('PROCESS_SPAWN_FAILED', error.message));
        }
      });
      child.once('close', (code, signal) => { request.signal?.removeEventListener('abort', abort); finish(code, signal); });
    });
  }

  async cancel(processId: string, reason: 'cancelled' | 'shutdown' = 'cancelled'): Promise<void> {
    const cancel = this.cancellers.get(processId);
    if (cancel) { cancel(reason); }
    if (reason === 'shutdown') { this.cancellers.delete(processId); }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const cancel of this.cancellers.values()) { cancel('shutdown'); }
    for (const pid of this.active) { try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ } }
    this.active.clear();
    this.cancellers.clear();
  }
}
