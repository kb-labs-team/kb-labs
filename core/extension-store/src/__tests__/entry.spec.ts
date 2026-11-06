import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseStoreEntry, readStoreEntry, serializeStoreEntry } from '../entry.js';
import { STORE_ENTRY_SCHEMA, type StoreEntry } from '../types.js';
import { sampleManifest } from './fixtures.js';

const baseEntry: StoreEntry = {
  schema: STORE_ENTRY_SCHEMA,
  name: '@kb-labs/commit',
  version: '2.120.1',
  kind: 'plugin',
  integrity: 'sha512-abc123',
  installedAt: '2026-09-26T10:00:00.000Z',
};

describe('parseStoreEntry', () => {
  it('round-trips a minimal valid entry', () => {
    const parsed = parseStoreEntry(serializeStoreEntry(baseEntry), 'entry.json');
    expect(parsed).toEqual(baseEntry);
  });

  it('round-trips an entry with a manifest and sdkApiVersion', () => {
    const entry: StoreEntry = {
      ...baseEntry,
      sdkApiVersion: '^1.0.0',
      manifest: sampleManifest('@kb-labs/commit', '2.120.1'),
    };
    expect(parseStoreEntry(serializeStoreEntry(entry), 'entry.json')).toEqual(entry);
  });

  it('rejects an unknown schema', () => {
    const raw = JSON.stringify({ ...baseEntry, schema: 'kb.store-entry/2' });
    expect(() => parseStoreEntry(raw, 'entry.json')).toThrow(/unsupported schema/);
  });

  it('rejects a missing name', () => {
    const { name: _name, ...rest } = baseEntry;
    expect(() => parseStoreEntry(JSON.stringify(rest), 'entry.json')).toThrow(/"name"/);
  });

  it('rejects an invalid kind', () => {
    const raw = JSON.stringify({ ...baseEntry, kind: 'adapter-ish' });
    expect(() => parseStoreEntry(raw, 'entry.json')).toThrow(/"kind"/);
  });

  it('rejects a manifest that is not a valid ManifestV3', () => {
    const raw = JSON.stringify({ ...baseEntry, manifest: { schema: 'kb.service/1' } });
    expect(() => parseStoreEntry(raw, 'entry.json')).toThrow(/"manifest"/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseStoreEntry('{not json', 'entry.json')).toThrow(/not valid JSON/);
  });
});

describe('readStoreEntry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-extension-store-entry-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when entry.json does not exist', async () => {
    await expect(readStoreEntry(path.join(dir, 'entry.json'))).resolves.toBeUndefined();
  });

  it('reads back a written entry', async () => {
    const file = path.join(dir, 'entry.json');
    await fs.writeFile(file, serializeStoreEntry(baseEntry));
    await expect(readStoreEntry(file)).resolves.toEqual(baseEntry);
  });

  it('throws on a corrupt entry.json rather than repairing it', async () => {
    const file = path.join(dir, 'entry.json');
    await fs.writeFile(file, '{"schema": "kb.store-entry/1"}');
    await expect(readStoreEntry(file)).rejects.toThrow();
  });
});
