import { describe, expect, it } from 'vitest';
import { findForbiddenDependencyProtocols } from '../../src/core/verifier.js';

describe('findForbiddenDependencyProtocols', () => {
  it('rejects workspace-only protocols in every published dependency section', () => {
    const issues = findForbiddenDependencyProtocols({
      dependencies: { '@kb-labs/core': 'workspace:*' },
      optionalDependencies: { native: 'file:../native' },
      peerDependencies: { plugin: 'link:../plugin' },
    });

    expect(issues).toEqual([
      'dependencies.@kb-labs/core uses forbidden workspace: dependency protocol (workspace:*)',
      'optionalDependencies.native uses forbidden file: dependency protocol (file:../native)',
      'peerDependencies.plugin uses forbidden link: dependency protocol (link:../plugin)',
    ]);
  });

  // Reproduces the "@kb-labs/plugin-execution-factory@2.114.0 shipped with
  // devDependencies.@kb-labs/gateway-core = 'workspace:*'" incident: this
  // check didn't scan devDependencies at all, so a leftover workspace:/link:/
  // file: protocol there passed silently — even though @npmcli/arborist
  // (what npm's own install actually uses) parses devDependencies too and
  // throws EUNSUPPORTEDPROTOCOL on it deep in someone else's dependency
  // graph, well after this cheap static check should have caught it.
  it('rejects a workspace: protocol left in devDependencies', () => {
    const issues = findForbiddenDependencyProtocols({
      devDependencies: { '@kb-labs/gateway-core': 'workspace:*' },
    });

    expect(issues).toEqual([
      'devDependencies.@kb-labs/gateway-core uses forbidden workspace: dependency protocol (workspace:*)',
    ]);
  });

  it('accepts registry-compatible dependency ranges', () => {
    expect(findForbiddenDependencyProtocols({
      dependencies: { '@kb-labs/core': '^2.115.0', lodash: '4.17.21' },
      peerDependencies: { typescript: '>=5' },
    })).toEqual([]);
  });
});
