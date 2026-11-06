import assert from 'node:assert/strict';
import test from 'node:test';

import { loadComposePorts, parseComposePorts } from './ports.mjs';

test('compose service ports are container targets, independent of host override', () => {
  const ports = parseComposePorts({
    services: {
      gateway: { ports: ['${KB_GATEWAY_HOST_PORT:-4000}:4000'] },
      registry: { ports: [{ target: 5071, published: 15071 }] },
    },
  });

  assert.deepEqual(ports.get('gateway'), [4000]);
  assert.deepEqual(ports.get('registry'), [5071]);
});

test('compose port validation reads service targets when host ports are configurable', () => {
  const ports = loadComposePorts();

  assert.deepEqual(ports.get('kb-gateway'), [4000]);
  assert.deepEqual(ports.get('kb-marketplace-registry'), [5071]);
});
