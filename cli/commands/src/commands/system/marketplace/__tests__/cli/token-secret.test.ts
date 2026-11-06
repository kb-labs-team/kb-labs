import { describe, expect, it } from 'vitest';
import { parseArgs, registerSecretFlagValues } from '@kb-labs/cli-runtime';
import { marketplaceGroup } from '../../index.js';

describe('marketplace install token declaration', () => {
  // case: S-203.3
  it('parses --token using the shipped secret flag and registers it before dispatch', () => {
    const installCommand = marketplaceGroup.commands.find(({ name }) => name === 'install');
    const flags = installCommand?.flags ?? [];
    expect(flags).toContainEqual(expect.objectContaining({ name: 'token', type: 'string', secret: true }));

    const { flagsObj } = parseArgs(['marketplace', 'install', '--token', 'x46-marketplace-token-fixture']);
    registerSecretFlagValues(flags, flagsObj);
  });
});
