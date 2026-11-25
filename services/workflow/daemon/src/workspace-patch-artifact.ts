import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface WorkspacePatchSource {
  patch: NodeJS.ReadableStream;
  baseCommit: string;
  changedFiles: string[];
}

export interface AtomicArtifactWriter {
  produceAtomic(path: string, input: NodeJS.ReadableStream): Promise<void>;
}

export interface WorkspacePatchArtifactResult {
  status: 'captured' | 'no_changes';
  sizeBytes: number;
  sha256: string;
}

/** Stream a patch through the digest and atomic writer with a bounded lifetime. */
export async function writeWorkspacePatchArtifact(input: {
  source: WorkspacePatchSource;
  artifacts: AtomicArtifactWriter;
  artifactKey: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<WorkspacePatchArtifactResult> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('Workspace patch transfer timed out')), input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const digestStream = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
      callback(null, bytes);
    },
  });

  const transfer = pipeline(input.source.patch, digestStream, { signal });
  const write = input.artifacts.produceAtomic(input.artifactKey, digestStream);
  try {
    await Promise.all([transfer, write]);
    return {
      status: sizeBytes === 0 ? 'no_changes' : 'captured',
      sizeBytes,
      sha256: hash.digest('hex'),
    };
  } catch {
    digestStream.destroy();
    const patchStream = input.source.patch as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
    patchStream.destroy?.();
    await Promise.allSettled([transfer, write]);
    throw Object.assign(new Error('Workspace patch transfer or artifact storage failed'), {
      code: 'WORKFLOW_PATCH_ARTIFACT_FAILED',
    });
  } finally {
    clearTimeout(timer);
  }
}
