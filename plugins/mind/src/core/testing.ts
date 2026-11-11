/**
 * Functional in-memory test harness for the engine.
 *
 * `@kb-labs/sdk/testing`'s `createTestContext` returns *mock* platform services
 * (empty/noop) — fine for handler wiring, useless for exercising retrieval.
 * This harness provides REAL behaviour: a deterministic bag-of-words embedder
 * and working in-memory vector store / storage, so ingest+retrieve and
 * namespace isolation can be tested end-to-end without a daemon or network.
 *
 * Imports only types from `@kb-labs/sdk`; the implementations are local.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type {
  MindServices,
  IVectorStore,
  IEmbeddings,
  IStorage,
  ICache,
  ILLM,
  ILogger,
  VectorRecord,
  VectorSearchResult,
  VectorFilter,
} from './services';

const EMBED_DIM = 64;

/** Deterministic bag-of-words embedder: shared tokens → higher cosine similarity. */
export class DeterministicEmbedder implements IEmbeddings {
  readonly dimensions = EMBED_DIM;
  /** Number of texts embedded — lets tests assert delta re-indexing skips work. */
  embedCount = 0;

  async embed(text: string): Promise<number[]> {
    this.embedCount += 1;
    const vec = new Array<number>(EMBED_DIM).fill(0);
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      let h = 0;
      for (let i = 0; i < token.length; i++) {
        h = (h * 31 + token.charCodeAt(i)) >>> 0;
      }
      const idx = h % EMBED_DIM;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async getDimensions(): Promise<number> {
    return EMBED_DIM;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** Minimal namespace-partitioned in-memory vector store (mirrors platform semantics). */
export class TestVectorStore implements IVectorStore {
  private ns = new Map<string, Map<string, VectorRecord>>();

  private part(namespace?: string): Map<string, VectorRecord> {
    const key = namespace ?? '';
    let p = this.ns.get(key);
    if (!p) {
      p = new Map();
      this.ns.set(key, p);
    }
    return p;
  }

  async search(query: number[], limit: number, _filter?: VectorFilter, namespace?: string): Promise<VectorSearchResult[]> {
    return [...this.part(namespace).values()]
      .map((r) => ({ id: r.id, score: cosine(query, r.vector), metadata: r.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async upsert(vectors: VectorRecord[], namespace?: string): Promise<void> {
    const p = this.part(namespace);
    for (const v of vectors) {
      p.set(v.id, v);
    }
  }

  async delete(ids: string[], namespace?: string): Promise<void> {
    const p = this.part(namespace);
    for (const id of ids) {
      p.delete(id);
    }
  }

  async count(namespace?: string): Promise<number> {
    return this.part(namespace).size;
  }

  async query(_filter: VectorFilter, namespace?: string): Promise<VectorRecord[]> {
    return [...this.part(namespace).values()];
  }
}

/** Minimal in-memory storage with prefix listing. */
export class TestStorage implements IStorage {
  private files = new Map<string, Buffer>();

  seed(path: string, content: string): void {
    this.files.set(path, Buffer.from(content, 'utf8'));
  }

  async read(path: string): Promise<Buffer | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, data: Buffer): Promise<void> {
    this.files.set(path, data);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix));
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
  child() {
    return noopLogger;
  },
} as unknown as ILogger;

const stubCache: ICache = {
  async get() {
    return null;
  },
  async set() {},
  async delete() {},
  async clear() {},
  async zadd() {},
  async zrangebyscore() {
    return [];
  },
} as unknown as ICache;

const stubLLM: ILLM = {
  async complete() {
    return { content: '', usage: { promptTokens: 0, completionTokens: 0 } };
  },
} as unknown as ILLM;

/** Scripted LLM that returns a fixed completion — for testing agent synthesis. */
export function makeScriptedLLM(content: string): ILLM {
  return {
    async complete() {
      return { content, usage: { promptTokens: 0, completionTokens: 0 } };
    },
  } as unknown as ILLM;
}

export interface TestServices extends MindServices {
  storage: TestStorage;
  vectorStore: TestVectorStore;
}

/** Build functional in-memory `MindServices` for engine tests. */
export function makeTestServices(overrides: Partial<MindServices> = {}): TestServices {
  const storage = new TestStorage();
  const vectorStore = new TestVectorStore();
  return {
    storage,
    vectorStore,
    embeddings: new DeterministicEmbedder(),
    cache: stubCache,
    llm: stubLLM,
    logger: noopLogger,
    ...overrides,
  } as TestServices;
}

export interface TestWorkspace {
  /** Workspace root (a real temp dir) — pass as `createMind(..., { cwd })`. */
  cwd: string;
  /** In-memory services (vector store + manifest storage). */
  services: TestServices;
}

/**
 * Materialize source files on disk (a temp dir) so the engine exercises its
 * REAL discovery (globby + fs + ignores) instead of in-memory seeding — this is
 * what catches discovery bugs (e.g. node_modules recursion). The vector store
 * and manifest stay in-memory via `makeTestServices`.
 */
export function makeTestWorkspace(
  files: Record<string, string>,
  overrides: Partial<MindServices> = {},
): TestWorkspace {
  const cwd = mkdtempSync(join(tmpdir(), 'mind-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return { cwd, services: makeTestServices(overrides) };
}
