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
