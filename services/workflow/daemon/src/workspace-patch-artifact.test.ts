import { createHash } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { writeWorkspacePatchArtifact } from './workspace-patch-artifact.js';

function memoryWriter() {
  const stored = new Map<string, Buffer>();
  return {
    stored,
    async produceAtomic(key: string, input: NodeJS.ReadableStream): Promise<void> {
      const chunks: Buffer[] = [];
      await pipeline(input, new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }));
      stored.set(key, Buffer.concat(chunks));
    },
  };
}

describe('writeWorkspacePatchArtifact', () => {
  it('streams the complete patch through the writer and returns matching size and digest', async () => {
    const writer = memoryWriter();
    const bytes = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.alloc(1_100_000, 0x71)]);
    const result = await writeWorkspacePatchArtifact({
      source: { patch: Readable.from([bytes]), baseCommit: 'a'.repeat(40), changedFiles: ['large.bin'] },
      artifacts: writer,
      artifactKey: 'runs/1/patch',
      timeoutMs: 5_000,
    });

    expect(writer.stored.get('runs/1/patch')).toEqual(bytes);
    expect(result).toEqual({
      status: 'captured',
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('aborts a stalled stream at the transfer deadline', async () => {
    const writer = memoryWriter();
    const source = new PassThrough();
    const startedAt = Date.now();

    await expect(writeWorkspacePatchArtifact({
      source: { patch: source, baseCommit: 'a'.repeat(40), changedFiles: [] },
      artifacts: writer,
      artifactKey: 'runs/2/patch',
      timeoutMs: 25,
    })).rejects.toMatchObject({ code: 'WORKFLOW_PATCH_ARTIFACT_FAILED' });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(writer.stored.has('runs/2/patch')).toBe(false);
  });

  it('destroys the producer stream when atomic storage fails', async () => {
    const source = new PassThrough();
    const writer = { async produceAtomic() { throw new Error('disk full'); } };

    await expect(writeWorkspacePatchArtifact({
      source: { patch: source, baseCommit: 'a'.repeat(40), changedFiles: [] },
      artifacts: writer,
      artifactKey: 'runs/3/patch',
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: 'WORKFLOW_PATCH_ARTIFACT_FAILED' });

    expect(source.destroyed).toBe(true);
  });
});
