import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AdapterUnavailableError } from '../errors.js';
import {
  ERROR_STAGES,
  createErrorEnvelope,
  errorCatalog,
  getCatalogEntry,
  renderTemplate,
  toErrorEnvelope,
  validateErrorEnvelope,
} from './index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtureDir = join(here, 'fixtures');

function loadFixtures(kind: 'valid' | 'invalid'): Array<{ name: string; value: unknown }> {
  const dir = join(fixtureDir, kind);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ name: file, value: JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown }));
}

describe('errors.catalog.json lint', () => {
  it('has unique codes', () => {
    const codes = errorCatalog.codes.map((entry) => entry.code);
    expect(codes.filter((code, index) => codes.indexOf(code) !== index)).toEqual([]);
  });

  it('gives every code a non-empty message and hint', () => {
    for (const entry of errorCatalog.codes) {
      expect(entry.message.trim(), `${entry.code} message`).not.toBe('');
      expect(entry.hint.trim(), `${entry.code} hint`).not.toBe('');
    }
  });

  it('only uses KB_ codes whose prefix matches the area (adapter codes belong to plugin)', () => {
    const prefixArea: Record<string, string> = {
      INSTALL: 'install',
      HOST: 'host',
      AUTH: 'auth',
      PROJECT: 'project',
      CONFIG: 'config',
      PLUGIN: 'plugin',
      ADAPTER: 'plugin',
      UPDATE: 'update',
      RUNTIME: 'runtime',
    };
    for (const entry of errorCatalog.codes) {
      const prefix = entry.code.split('_')[1] ?? '';
      expect(entry.code.startsWith('KB_'), entry.code).toBe(true);
      expect(prefixArea[prefix], `${entry.code} prefix`).toBe(entry.area);
    }
  });

  it('uses only stages from the documented journey vocabulary', () => {
    for (const entry of errorCatalog.codes) {
      expect(ERROR_STAGES as readonly string[], entry.code).toContain(entry.stage);
    }
  });

  it('renders every entry into a valid envelope with no unresolved placeholders', () => {
    for (const entry of errorCatalog.codes) {
      const placeholders = [...`${entry.message} ${entry.hint}`.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(
        (match) => match[1] ?? '',
      );
      const details = Object.fromEntries(placeholders.map((name) => [name, `<${name}>`]));
      const envelope = createErrorEnvelope(entry.code, { details });
      expect(validateErrorEnvelope(envelope), entry.code).toEqual([]);
      expect(envelope.message).not.toContain('{');
      expect(envelope.hint).not.toContain('{');
    }
  });

  it('keeps the launcher error codes that the Go side emits', () => {
    for (const code of [
      'KB_INSTALL_INCOMPATIBLE_COMPONENTS',
      'KB_INSTALL_PROVIDER_UNRESOLVED',
      'KB_INSTALL_PROVIDER_AMBIGUOUS',
      'KB_INSTALL_INPUT_REQUIRED',
      'KB_INSTALL_CONFIG_REQUIRED',
      'KB_INSTALL_ARTIFACT_MANIFEST_MISMATCH',
      'KB_INSTALL_SERVICE_GRAPH_MISMATCH',
    ]) {
      expect(getCatalogEntry(code), code).toBeDefined();
    }
    expect(errorCatalog.codes.some((entry) => entry.code.startsWith('KB_CREATE_'))).toBe(false);
  });
});

describe('shared envelope fixtures', () => {
  for (const { name, value } of loadFixtures('valid')) {
    it(`accepts valid/${name}`, () => {
      expect(validateErrorEnvelope(value)).toEqual([]);
    });
  }
  for (const { name, value } of loadFixtures('invalid')) {
    it(`rejects invalid/${name}`, () => {
      expect(validateErrorEnvelope(value).length).toBeGreaterThan(0);
    });
  }
});

describe('renderTemplate', () => {
  it('fills known placeholders and marks missing ones', () => {
    expect(renderTemplate('Port {port} in {where}', { port: '4000' })).toBe('Port 4000 in unknown');
  });
});

describe('toErrorEnvelope (platform errors)', () => {
  it('maps a not-configured adapter to KB_ADAPTER_NOT_CONFIGURED', () => {
    const envelope = toErrorEnvelope(new AdapterUnavailableError('llm'), { correlationId: 'c1' });
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_ADAPTER_NOT_CONFIGURED');
    expect(envelope.details).toEqual({ service: 'llm', adapter: 'adapters.llm' });
    expect(envelope.correlationId).toBe('c1');
    expect(envelope.hint).toContain('adapters.llm');
  });

  it('maps a load-failed adapter to KB_HOST_ADAPTER_UNAVAILABLE', () => {
    const envelope = toErrorEnvelope(new AdapterUnavailableError('cache', 'load-failed'));
    expect(envelope.code).toBe('KB_HOST_ADAPTER_UNAVAILABLE');
    expect(envelope.retryable).toBe(true);
    expect(envelope.details).toEqual({ slot: 'cache', reason: 'load-failed' });
  });

  it('wraps unknown values as KB_RUNTIME_UNEXPECTED', () => {
    const envelope = toErrorEnvelope('boom');
    expect(envelope.code).toBe('KB_RUNTIME_UNEXPECTED');
    expect(envelope.cause).toBe('boom');
  });

  it('rejects codes that are not in the catalog', () => {
    expect(() => createErrorEnvelope('KB_NOPE_NOPE')).toThrow(/errors\.catalog\.json/);
  });
});
