import test from 'node:test';
import assert from 'node:assert/strict';

import { colorPolicy, resolveColorSupport } from './color-policy.mjs';

test('color policy declaration cases match the resolver', () => {
  for (const { name, tty, noColor, forceColor, term, want } of colorPolicy.cases) {
    assert.equal(resolveColorSupport(tty, noColor, forceColor, term), want, name);
  }
});
