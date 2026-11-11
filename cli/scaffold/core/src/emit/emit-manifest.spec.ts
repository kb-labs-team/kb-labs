import { describe, expect, it } from 'vitest';
import { emitManifest } from './emit-manifest.js';

describe('emitManifest', () => {
  it('writes the named manifest export used by all loaders', () => {
    const source = emitManifest({
      schema: 'kb.plugin/3', id: '@fixture/plugin', version: '1.0.0',
    }, { imports: [], permissions: [] });

    expect(source).toContain('export const manifest: typeof baseManifest & { permissions: unknown } = { ...baseManifest, permissions };');
    expect(source).not.toContain('export default');
  });
});
