import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

export const BUILD_MEMORY_BUDGET_FRACTION = 0.7;
// Largest observed task-process RSS in run 40424362740, read from the 30-second resource samples.
export const CALIBRATED_TASK_FOOTPRINT_BYTES = 2_536_468_480;

export class BuildCapacityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BuildCapacityError';
    this.code = code;
  }
}

export function deriveBuildLimits({ cpuCount, totalBytes, availableBytes, expectedTaskFootprintBytes = CALIBRATED_TASK_FOOTPRINT_BYTES }) {
  if (!Number.isSafeInteger(cpuCount) || cpuCount < 1) throw new BuildCapacityError('Runner CPU count must be a positive integer.', 'RUNNER_CPU_INVALID');
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) throw new BuildCapacityError('Runner MemTotal must be a positive integer.', 'RUNNER_MEMTOTAL_INVALID');
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 1) throw new BuildCapacityError('Runner MemAvailable must be a positive integer.', 'RUNNER_MEMAVAILABLE_INVALID');
  if (!Number.isSafeInteger(expectedTaskFootprintBytes) || expectedTaskFootprintBytes < 1) throw new Error('Expected task footprint must be a positive integer measured in bytes.');
  const memoryBudgetBytes = Math.min(Math.floor(totalBytes * BUILD_MEMORY_BUDGET_FRACTION), availableBytes);
  const memoryBoundConcurrency = Math.floor(memoryBudgetBytes / expectedTaskFootprintBytes);
  if (memoryBoundConcurrency < 1) throw new BuildCapacityError('Runner available memory cannot fit one build task.', 'RUNNER_MEMORY_CAPACITY_INSUFFICIENT');
  const concurrency = Math.min(cpuCount, memoryBoundConcurrency);
  return { cpuCount, memoryBudgetBytes, concurrency, expectedTaskFootprintBytes };
}

export function measureBuildLimits({
  readCpuCount = () => os.availableParallelism(),
  readMeminfo = () => readFileSync('/proc/meminfo', 'utf8'),
} = {}) {
  return deriveBuildLimits({ cpuCount: readCpuCount(), ...readRunnerMemory(readMeminfo) });
}

export function readRunnerMemory(readMeminfo = () => readFileSync('/proc/meminfo', 'utf8')) {
  let content;
  try {
    content = readMeminfo();
  } catch (error) {
    throw new Error(`Could not read Linux /proc/meminfo: ${error.message}`, { cause: error });
  }
  return parseMeminfo(content);
}

export function sampleRunnerResources({
  workspaceRoot,
  readMeminfo = () => process.platform === 'linux'
    ? readFileSync('/proc/meminfo', 'utf8')
    : `MemTotal: ${Math.floor(os.totalmem() / 1024)} kB\nMemAvailable: ${Math.floor(os.freemem() / 1024)} kB\n`,
  run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }),
  now = Date.now,
}) {
  const memory = readRunnerMemory(readMeminfo);
  const diskOutput = run('df', ['-Pk', workspaceRoot]);
  const diskRows = diskOutput.trim().split(/\r?\n/);
  const diskFields = diskRows.at(-1)?.trim().split(/\s+/) ?? [];
  const availableBlocks = Number(diskFields[3]);
  if (!Number.isSafeInteger(availableBlocks)) throw new Error(`Could not parse available workspace disk from df output: ${diskOutput}`);
  const processOutput = run('ps', ['-eo', 'pid=,rss=,comm=', '--sort=-rss']);
  const topRss = processOutput.split(/\r?\n/).filter(Boolean).slice(0, 5).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) throw new Error(`Could not parse process RSS sample: ${line}`);
    return { pid: Number(match[1]), rssBytes: Number(match[2]) * 1024, command: match[3] };
  });
  return {
    sampledAt: new Date(now()).toISOString(),
    memory: { ...memory, usedBytes: memory.totalBytes - memory.availableBytes },
    disk: { availableBytes: availableBlocks * 1024, workspace: workspaceRoot },
    topRss,
  };
}

export function resourcePeaks(samples) {
  return samples.reduce((peaks, sample) => ({
    peakMemoryBytes: Math.max(peaks.peakMemoryBytes, sample.memory.usedBytes),
    minimumFreeDiskBytes: Math.min(peaks.minimumFreeDiskBytes, sample.disk.availableBytes),
  }), { peakMemoryBytes: 0, minimumFreeDiskBytes: Number.MAX_SAFE_INTEGER });
}

function parseMeminfo(content) {
  const fields = new Map(content.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/);
    return match ? [[match[1], Number(match[2]) * 1024]] : [];
  }));
  const totalBytes = fields.get('MemTotal');
  const availableBytes = fields.get('MemAvailable');
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Linux /proc/meminfo is missing a valid MemTotal value.');
  if (!Number.isSafeInteger(availableBytes)) throw new Error('Linux /proc/meminfo is missing a valid MemAvailable value.');
  if (totalBytes < 1) throw new Error('Runner MemTotal must be a positive integer.');
  if (availableBytes < 1) throw new Error('Runner MemAvailable must be a positive integer.');
  return { totalBytes, availableBytes };
}
