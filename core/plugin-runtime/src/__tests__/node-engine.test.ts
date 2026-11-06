import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createErrorEnvelope, ErrorEnvelopeError, getCatalogEntry } from '@kb-labs/core-platform';
import { ensureNodeEngineSupported } from '../platform-resolve/node-engine.js';
import { parseNodeEnginePolicy } from '@kb-labs/plugin-contracts/node-engine-policy';

describe('installed runtime Node.js engine', () => {
  let temporary: string | undefined;

  afterEach(() => {
    if (temporary) {
      rmSync(temporary, { recursive: true, force: true });
      temporary = undefined;
    }
  });

  // case: S-260.4
  it('runtime rejects older and newer majors with catalogue fields', () => {
    temporary = mkdtempSync(join(tmpdir(), 'kb-node-engine-'));
    const packageRoot = join(temporary, 'node_modules', '@kb-labs', 'plugin-runtime');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@kb-labs/plugin-runtime',
      engines: { node: '24.x' },
    }));

    const entry = getCatalogEntry('KB_NODE_VERSION_UNSUPPORTED');
    expect(entry).toBeDefined();
    for (const actualVersion of ['20.19.4', '26.0.0']) {
      let caught: unknown;
      try {
        ensureNodeEngineSupported(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href, actualVersion);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ErrorEnvelopeError);
      const envelope = (caught as ErrorEnvelopeError).envelope;
      const expected = createErrorEnvelope('KB_NODE_VERSION_UNSUPPORTED', {
        details: { requiredMajor: '24', actualVersion },
      });
      expect(envelope).toMatchObject({
        code: 'KB_NODE_VERSION_UNSUPPORTED',
        details: { requiredMajor: '24', actualVersion },
        message: expected.message,
        hint: expected.hint,
      });
    }
  });

  it('accepts only the installed runtime major', () => {
    temporary = mkdtempSync(join(tmpdir(), 'kb-node-engine-'));
    const packageRoot = join(temporary, 'node_modules', '@kb-labs', 'plugin-runtime');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@kb-labs/plugin-runtime',
      engines: { node: '24.x' },
    }));
    expect(() => ensureNodeEngineSupported(
      pathToFileURL(join(packageRoot, 'dist', 'index.js')).href,
      '24.0.0',
    )).not.toThrow();
    expect(() => ensureNodeEngineSupported(
      pathToFileURL(join(packageRoot, 'dist', 'index.js')).href,
      '25.0.0',
    )).toThrow(ErrorEnvelopeError);
  });

  it('refuses engine declarations outside the one supported major form', () => {
    temporary = mkdtempSync(join(tmpdir(), 'kb-node-engine-'));
    const packageRoot = join(temporary, 'node_modules', '@kb-labs', 'plugin-runtime');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@kb-labs/plugin-runtime',
      engines: { node: '^24.0.0' },
    }));

    expect(() => ensureNodeEngineSupported(
      pathToFileURL(join(packageRoot, 'dist', 'index.js')).href,
      '24.0.0',
    )).toThrow('Unsupported Node.js engine declaration');
  });

  it('parses only a single MAJOR.x policy', () => {
    expect(parseNodeEnginePolicy('24.x')).toEqual({ requiredMajor: 24 });
    for (const declaration of ['>=24.0.0', '^24.x', '~24.x', '24.x || 26.x']) {
      expect(() => parseNodeEnginePolicy(declaration)).toThrow('Unsupported Node.js engine declaration');
    }
  });
});
