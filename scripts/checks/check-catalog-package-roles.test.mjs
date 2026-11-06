import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogRoleIssues } from './check-catalog-package-roles.mjs';

const packages = () => [
  {
    name: '@fixture/catalog', role: 'owner', dependencies: {
      '@kb-labs/core-discovery': 'workspace:*',
      '@kb-labs/plugin-contracts': 'workspace:*',
    },
  },
  {
    name: '@fixture/marketplace', role: 'writer', dependencies: {
      '@kb-labs/core-discovery': 'workspace:*',
      '@kb-labs/plugin-contracts': 'workspace:*',
    },
  },
  {
    name: '@fixture/reader', role: 'reader', dependencies: {
      '@kb-labs/core-registry': 'workspace:*',
      '@kb-labs/plugin-contracts': 'workspace:*',
    },
  },
];

test('catalog package roles reject an implementation dependency outside the owner and writer graph roles', () => {
  const graph = packages();
  graph[2].dependencies['@kb-labs/core-discovery'] = 'workspace:*';
  const red = catalogRoleIssues(graph);
  assert.equal(red.length, 1);
  assert.match(red[0].message, /@fixture\/reader.*core-discovery/);

  delete graph[2].dependencies['@kb-labs/core-discovery'];
  assert.deepEqual(catalogRoleIssues(graph), []);
});
