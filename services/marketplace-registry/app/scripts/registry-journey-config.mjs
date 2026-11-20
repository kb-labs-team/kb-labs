export function createRegistryJourneyConfig({ registryUrl, signingPublicKey }) {
  return {
    platform: { deployment: { topology: 'cloud' } },
    marketplace: {
      sources: [{ kind: 'registry', url: registryUrl, signingPublicKey }],
    },
  };
}
