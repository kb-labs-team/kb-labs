import { describe, it, expect } from 'vitest';
import { generateOpenAPISpec } from '../generators/openapi-spec.js';
import { mergeOpenAPISpecs } from '@kb-labs/plugin-contracts';
import { generateStudioRegistry } from '../generators/studio-registry.js';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { PluginBrief } from '@kb-labs/plugin-contracts';

function makeManifest(id: string, routes?: number): ManifestV3 {
  return {
    schema: 'kb.plugin/3',
    id,
    version: '1.0.0',
    display: { name: id },
    rest: routes ? {
      routes: Array.from({ length: routes }, (_, i) => ({
        method: 'GET' as const,
        path: `/api/${id.replace('@kb-labs/', '')}/${i}`,
        handler: `./dist/route-${i}.js`,
        description: `Route ${i}`,
      })),
    } : undefined,
    cli: {
      commands: [{ path: 'test', describe: 'Test cmd', handler: './dist/test.js' }],
    },
  };
}

describe('generateOpenAPISpec', () => {
  it('generates valid OpenAPI 3.1.0 spec', () => {
    const manifest = makeManifest('@kb-labs/api', 2);
    const spec = generateOpenAPISpec(manifest);

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('@kb-labs/api');
    expect(spec.info.version).toBe('1.0.0');
    expect(spec['x-kb-plugin-id']).toBe('@kb-labs/api');
    expect(Object.keys(spec.paths)).toHaveLength(2);
  });

  it('generates empty paths for manifest without routes', () => {
    const manifest = makeManifest('@kb-labs/no-rest');
    const spec = generateOpenAPISpec(manifest);
    expect(Object.keys(spec.paths)).toHaveLength(0);
  });
});

describe('mergeOpenAPISpecs', () => {
  it('returns empty spec for no inputs', () => {
    const merged = mergeOpenAPISpecs([]);
    expect(merged.openapi).toBe('3.1.0');
    expect(Object.keys(merged.paths)).toHaveLength(0);
  });

  it('returns single spec as-is', () => {
    const spec = generateOpenAPISpec(makeManifest('@kb-labs/single', 1));
    const merged = mergeOpenAPISpecs([spec]);
    expect(merged).toBe(spec);
  });

  it('merges multiple specs deterministically', () => {
    const spec1 = generateOpenAPISpec(makeManifest('@kb-labs/a', 1));
    const spec2 = generateOpenAPISpec(makeManifest('@kb-labs/b', 2));

    const merged1 = mergeOpenAPISpecs([spec1, spec2]);
    const merged2 = mergeOpenAPISpecs([spec2, spec1]); // reverse order

    expect(Object.keys(merged1.paths)).toHaveLength(3);
    // Deterministic: same result regardless of input order
    expect(JSON.stringify(merged1)).toBe(JSON.stringify(merged2));
  });

  it('adds x-kb-plugin-id to each operation', () => {
    const spec = generateOpenAPISpec(makeManifest('@kb-labs/tagged', 1));
    mergeOpenAPISpecs([spec]);
    // Single spec returns as-is, so test with 2
    const spec2 = generateOpenAPISpec(makeManifest('@kb-labs/other', 1));
    const merged2 = mergeOpenAPISpecs([spec, spec2]);

    const firstPath = Object.values(merged2.paths)[0] as Record<string, any>;
    const firstOp = firstPath.get;
    expect(firstOp['x-kb-plugin-id']).toBeDefined();
  });
});

describe('generateStudioRegistry', () => {
  it('generates sorted registry', () => {
    const plugins: PluginBrief[] = [
      { id: '@kb-labs/b', version: '1.0.0', source: { kind: 'local', path: './b' } },
      { id: '@kb-labs/a', version: '2.0.0', source: { kind: 'marketplace', path: './a' } },
    ];
    const manifests = new Map<string, ManifestV3>([
      ['@kb-labs/a', makeManifest('@kb-labs/a', 1)],
      ['@kb-labs/b', makeManifest('@kb-labs/b')],
    ]);

    const reg = generateStudioRegistry(plugins, manifests);
    expect(reg.version).toBe('1.0.0');
    expect(reg.plugins).toHaveLength(2);
    // Sorted alphabetically
    expect(reg.plugins[0]!.id).toBe('@kb-labs/a');
    expect(reg.plugins[1]!.id).toBe('@kb-labs/b');
  });

  it('detects capabilities from manifest', () => {
    const plugins: PluginBrief[] = [
      { id: '@kb-labs/full', version: '1.0.0', source: { kind: 'local', path: './full' } },
    ];
    const manifests = new Map<string, ManifestV3>([
      ['@kb-labs/full', makeManifest('@kb-labs/full', 3)],
    ]);

    const reg = generateStudioRegistry(plugins, manifests);
    expect(reg.plugins[0]!.capabilities.hasCommands).toBe(true);
    expect(reg.plugins[0]!.capabilities.hasRestAPI).toBe(true);
  });
});
