/** Build an endpoint URL for either the public Registry alias or a service base. */
export function registryEndpointUrl(registryUrl: string, endpoint: string): string {
  const base = new URL(registryUrl);
  const basePath = base.pathname.replace(/\/$/, '');
  const usesPublicAlias = basePath.endsWith('/api/v1/registry');
  const prefix = usesPublicAlias ? '' : '/api/v1';
  base.pathname = `${basePath}${prefix}/${endpoint.replace(/^\//, '')}`;
  base.search = '';
  base.hash = '';
  return base.toString();
}
