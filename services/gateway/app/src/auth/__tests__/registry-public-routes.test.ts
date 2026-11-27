import { describe, expect, it } from 'vitest';
import { isPlatformPublicRoute } from '../middleware.js';

describe('public Registry route allowlist', () => {
  it('allows exact global catalog and Marketplace read routes only', () => {
    expect(isPlatformPublicRoute('GET', '/api/v1/registry/packages')).toBe(true);
    expect(isPlatformPublicRoute('GET', '/api/v1/registry/packages/kirill/widget')).toBe(true);
    expect(isPlatformPublicRoute('GET', '/api/v1/marketplace-registry/api/v1/resolve/')).toBe(true);
    expect(isPlatformPublicRoute('GET', '/api/v1/marketplace-registry/api/v1/packages/kirill/widget/1.0.0/tarball')).toBe(true);
    expect(isPlatformPublicRoute('POST', '/api/v1/registry/packages/publish')).toBe(false);
    expect(isPlatformPublicRoute('POST', '/api/v1/marketplace-registry/api/v1/packages/publish')).toBe(false);
    expect(isPlatformPublicRoute('GET', '/api/v1/projects/prj_demo/marketplace-registry/api/v1/resolve')).toBe(false);
    expect(isPlatformPublicRoute('GET', '/api/v1/projects/prj_demo/marketplace-registry/api/v1/packages/kirill/widget')).toBe(false);
  });
});
