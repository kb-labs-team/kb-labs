export function platformAdapterOptions(releaseConfig, registryManifest) {
  const services = Object.fromEntries((registryManifest.services ?? [])
    .filter(({ id, port }) => id && port)
    .map(({ id, port }) => [id, { url: `http://127.0.0.1:${port}` }]));
  // Registry is an external transport target in this suite, not a platform
  // host service. Keep it in the trusted adapter defaults without adding it
  // to registryManifest.services or the host graph.
  services['marketplace-registry'] ??= { url: 'http://127.0.0.1:5071' };
  return {
    ...releaseConfig.adapterOptions,
    serviceTransport: {
      ...releaseConfig.adapterOptions.serviceTransport,
      services,
    },
  };
}
