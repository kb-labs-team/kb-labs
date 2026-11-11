import { describe, expect, it } from 'vitest';
import { pluginContractsManifest } from '../../src/contracts/contract.js';
import { parsePluginContracts } from '../../src/contracts/schema/contract.schema.js';
import { contractsVersion } from '../../src/contracts/version.js';

describe('pluginContractsManifest', () => {
  it('is valid according to the schema', () => {
    expect(() => parsePluginContracts(pluginContractsManifest)).not.toThrow();
  });

  it('rejects malformed manifests', () => {
    const malformed = {
      ...pluginContractsManifest,
      schema: 'kb.plugin.contracts/999'
    };

    expect(() => parsePluginContracts(malformed)).toThrowError();
  });

  it('uses a semver-compatible contractsVersion', () => {
    const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
    expect(semverPattern.test(contractsVersion)).toBe(true);
  });
});

