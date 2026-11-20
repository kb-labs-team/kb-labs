export function createRegistryJourneyConfig({ registryUrl, signingPublicKey }) {
  if (typeof registryUrl !== 'string' || registryUrl.length === 0) {
    throw new TypeError('registryUrl must be a non-empty string');
  }
  if (typeof signingPublicKey !== 'string' || signingPublicKey.length === 0) {
    throw new TypeError('signingPublicKey must be a non-empty string');
  }

  return {
    marketplace: {
      sources: [{ kind: 'registry', url: registryUrl, signingPublicKey }],
    },
  };
}

export function createRegistryJourneyTopology({ gatewayUrl, registryBackendUrl, proxyUrl }) {
  for (const [name, value] of Object.entries({ gatewayUrl, registryBackendUrl, proxyUrl })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty URL`);
    }
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new TypeError(`${name} must use HTTP or HTTPS`);
    }
  }
  const gatewayOrigin = gatewayUrl.replace(/\/+$/, '');
  const registryGatewayBase = `${gatewayOrigin}/api/v1/marketplace-registry`;
  const registryGatewayApiBase = `${registryGatewayBase}/api/v1`;
  return {
    marketplaceSourceUrl: registryGatewayBase,
    marketplaceProxyUrl: proxyUrl.replace(/\/+$/, ''),
    marketplaceGatewayDataPrefix: registryGatewayApiBase,
    marketplacePublishUrl: registryGatewayApiBase,
    registryAdvertisedBaseUrl: registryGatewayBase,
    tamperUpstreamUrl: registryBackendUrl.replace(/\/+$/, ''),
  };
}
