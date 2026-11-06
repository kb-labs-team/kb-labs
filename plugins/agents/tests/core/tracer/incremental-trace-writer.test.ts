import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { IncrementalTraceWriter } from '../../../src/tracing/index.js';
import type { IterationDetailEvent } from '../../../src/contracts/index.js';

describe('IncrementalTraceWriter', () => {
  const testDir = './.test-traces';
  const taskId = 'test-task-123';
  let writer: IncrementalTraceWriter;

  beforeEach(async () => {
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });

    // Create writer
    writer = new IncrementalTraceWriter(taskId, {}, testDir);
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });

  it('should create NDJSON file on trace', async () => {
    const event: IterationDetailEvent = {
      seq: 0, // Will be auto-incremented
      timestamp: new Date().toISOString(),
      type: 'iteration:detail',
      iteration: 1,
      config: {
        maxIterations: 10,
        mode: 'auto',
        temperature: 0.1,
      },
      availableTools: {
        total: 5,
        tools: ['fs:read', 'grep_search'],
      },
      context: {
        messagesCount: 10,
        totalTokens: 1000,
        conversationSummary: 'Test conversation',
      },
    };

    writer.trace(event);

    // Wait for flush
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    // Check file exists
    const filepath = path.join(testDir, `${taskId}.ndjson`);
    const exists = await fs.access(filepath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // Read and parse
    const content = await fs.readFile(filepath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const line = lines[0];
    expect(line).toBeDefined();
    if (!line) throw new Error('trace writer did not persist an entry');
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe('iteration:detail');
    expect(parsed.seq).toBe(1); // Auto-incremented
    expect(parsed.iteration).toBe(1);
  });

  it('should auto-increment seq numbers', async () => {
    writer.trace({ type: 'iteration:detail', iteration: 1 } as any);
    writer.trace({ type: 'llm:call', iteration: 1 } as any);
    writer.trace({ type: 'tool:execution', iteration: 1 } as any);

    // Wait for flush
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    const content = await fs.readFile(path.join(testDir, `${taskId}.ndjson`), 'utf-8');
    const entries = content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it('should flush on buffer size limit', async () => {
    // Add 11 events (maxBufferSize = 10)
    for (let i = 1; i <= 11; i++) {
      writer.trace({ type: 'iteration:detail', iteration: i } as any);
    }

    // Wait for flush
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const entries = writer.getEntries();
    expect(entries.length).toBeGreaterThanOrEqual(10);
  });

  it('should redact secrets', async () => {
    const event = {
      type: 'tool:execution',
      iteration: 1,
      input: {
        apiKey: 'sk-abc123def456ghi789jkl012mno345',  // 20+ chars after sk-
        password: 'password: "mysecretpass"',
      },
    } as any;

    writer.trace(event);

    // Wait for flush
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    const entries = writer.getEntries();
    const redacted = entries[0] as any;

    expect(redacted.input.apiKey).toBe('[REDACTED]');
    expect(redacted.input.password).toContain('[REDACTED]');
  });

  it('should redact paths', async () => {
    const event = {
      type: 'tool:execution',
      iteration: 1,
      input: {
        file: '/Users/john/project/file.ts',
      },
    } as any;

    writer.trace(event);

    // Wait for flush
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    const entries = writer.getEntries();
    const redacted = entries[0] as any;

    expect(redacted.input.file).toBe('~/john/project/file.ts');
  });

  it('should create index on finalize', async () => {
    writer.trace({ type: 'iteration:detail', iteration: 1 } as any);
    writer.trace({ type: 'llm:call', iteration: 1 } as any);
    writer.trace({ type: 'tool:execution', iteration: 1 } as any);

    await writer.finalize();

    const indexPath = path.join(testDir, `${taskId}-index.json`);
    const exists = await fs.access(indexPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(indexPath, 'utf-8');
    const index = JSON.parse(content);

    expect(index.taskId).toBe(taskId);
    expect(index.summary.totalEvents).toBe(3);
    expect(index.summary.iterations).toBe(1);
  });

  it('should cleanup old traces', async () => {
    // Create 35 trace files (maxTraces = 30) in parallel for faster test execution
    await Promise.all(
      Array.from({ length: 35 }, async (_, i) => {
        const testWriter = new IncrementalTraceWriter(`task-${i + 1}`, {}, testDir);
        testWriter.trace({ type: 'iteration:detail', iteration: 1 } as any);
        await testWriter.finalize();
      })
    );

    // Check that only 30 files remain
    const files = await fs.readdir(testDir);
    const traceFiles = files.filter((f) => f.endsWith('.ndjson'));
    expect(traceFiles.length).toBe(30);
  });
});
