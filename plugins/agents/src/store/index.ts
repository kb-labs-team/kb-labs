import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  AgentSession,
  KernelState,
  MemoryRollup,
  RuntimeTurnRecord,
  KernelMemoryState,
  ToolCallRecord,
} from '../contracts/index.js';

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

export class SessionArtifactStore {
  constructor(private readonly workingDir: string) {}

  getSessionsRoot(): string {
    return path.join(this.workingDir, '.kb', 'agents', 'sessions');
  }

  getSessionDir(sessionId: string): string {
    return path.join(this.getSessionsRoot(), sessionId);
  }

  getArtifactPath(sessionId: string, name: string): string {
    return path.join(this.getSessionDir(sessionId), name);
  }

  async ensureSessionArtifacts(sessionId: string): Promise<void> {
    const dir = this.getSessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const emptyJsonFiles = [
      'memory.json',
      'memory-rollup.json',
      'kernel-state.json',
      'plan.json',
      'file-changes.json',
    ];
    await Promise.all(
      emptyJsonFiles.map(async (name) => {
        const target = this.getArtifactPath(sessionId, name);
        try {
          await fs.access(target);
        } catch {
          const initial = name === 'file-changes.json' ? [] : null;
          await fs.writeFile(target, `${JSON.stringify(initial, null, 2)}\n`, 'utf-8');
        }
      }),
    );

    const emptyLogFiles = ['turns.jsonl', 'tool-ledger.jsonl', 'run-ledger.jsonl', 'trace.ndjson'];
    await Promise.all(
      emptyLogFiles.map(async (name) => {
        const target = this.getArtifactPath(sessionId, name);
        try {
          await fs.access(target);
        } catch {
          await fs.writeFile(target, '', 'utf-8');
        }
      }),
    );
  }

  async saveSessionMetadata(session: AgentSession & Record<string, unknown>): Promise<void> {
    await this.ensureSessionArtifacts(session.id);
    await fs.writeFile(
      this.getArtifactPath(session.id, 'session.json'),
      `${JSON.stringify(session, null, 2)}\n`,
      'utf-8',
    );
  }

  async saveKernelState(sessionId: string, state: KernelState): Promise<void> {
    await this.ensureSessionArtifacts(sessionId);
    await fs.writeFile(
      this.getArtifactPath(sessionId, 'kernel-state.json'),
      `${JSON.stringify(state, null, 2)}\n`,
      'utf-8',
    );
    await this.saveMemorySnapshot(sessionId, state.memory);
    await this.saveMemoryRollup(sessionId, state.rollup ?? null);
  }

  async loadKernelState(sessionId: string): Promise<KernelState | null> {
    try {
      const content = await fs.readFile(this.getArtifactPath(sessionId, 'kernel-state.json'), 'utf-8');
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === 'object' && parsed.sessionId ? parsed as KernelState : null;
    } catch {
      return null;
    }
  }

  async saveMemorySnapshot(sessionId: string, memory: KernelMemoryState): Promise<void> {
    await this.ensureSessionArtifacts(sessionId);
    await fs.writeFile(
      this.getArtifactPath(sessionId, 'memory.json'),
      `${JSON.stringify(memory, null, 2)}\n`,
      'utf-8',
    );
  }

  async saveMemoryRollup(sessionId: string, rollup: MemoryRollup | null): Promise<void> {
    await this.ensureSessionArtifacts(sessionId);
    await fs.writeFile(
      this.getArtifactPath(sessionId, 'memory-rollup.json'),
      `${JSON.stringify(rollup, null, 2)}\n`,
      'utf-8',
    );
  }

  async countArtifactLines(sessionId: string, name: string): Promise<number> {
    try {
      const content = await fs.readFile(this.getArtifactPath(sessionId, name), 'utf-8');
      if (!content.trim()) {
        return 0;
      }
      return content.split('\n').filter((line) => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  async appendTurn(sessionId: string, turn: RuntimeTurnRecord): Promise<void> {
    await appendJsonLine(this.getArtifactPath(sessionId, 'turns.jsonl'), turn);
  }

  async appendToolRecord(sessionId: string, record: ToolCallRecord): Promise<void> {
    await appendJsonLine(this.getArtifactPath(sessionId, 'tool-ledger.jsonl'), record);
  }

  async loadToolRecords(sessionId: string, limit = 200): Promise<ToolCallRecord[]> {
    const records = await readJsonLines<ToolCallRecord>(this.getArtifactPath(sessionId, 'tool-ledger.jsonl'));
    if (limit <= 0 || records.length <= limit) {
      return records;
    }
    return records.slice(-limit);
  }

  async appendRunRecord(sessionId: string, record: Record<string, unknown>): Promise<void> {
    await appendJsonLine(this.getArtifactPath(sessionId, 'run-ledger.jsonl'), record);
  }
}
