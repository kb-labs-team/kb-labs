import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf-8');
const entrypoint = readFileSync(resolve(__dirname, '../../docker-entrypoint.sh'), 'utf-8');

describe('gateway production image contract', () => {
  it('bakes the generated cloud config default into the release image', () => {
    expect(dockerfile).toContain('COPY --chown=kb:nodejs .kb/deploy/image-default/kb.config.json /app/.kb/kb.config.json');
    expect(dockerfile).not.toContain('kb.config.prod.json');
    expect(dockerfile).not.toContain('marketplace.prod.lock');
    expect(dockerfile).not.toContain('kb.config.default.json');
    expect(dockerfile).not.toContain('marketplace.default.lock');
  });

  it('starts from the baked cloud config and allows a delivery overlay', () => {
    expect(entrypoint).toContain('Release images contain a cloud default config');
    expect(entrypoint).not.toContain('/app/.kb/kb.config.json or kb.config.jsonc is required');
    expect(entrypoint).not.toContain('/app/.kb/marketplace.lock is required');
    expect(entrypoint).not.toContain('cp /app/.kb/');
  });
});
