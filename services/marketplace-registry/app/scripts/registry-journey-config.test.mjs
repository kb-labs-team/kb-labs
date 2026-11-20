import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistryJourneyConfig, createRegistryJourneyTopology } from './registry-journey-config.mjs';

describe('Registry journey Gateway topology', () => {
  it('keeps Marketplace reads, publish, and advertised tarball links on the Gateway route', () => {
    const topology = createRegistryJourneyTopology({
      gatewayUrl: 'http://127.0.0.1:4000/',
      registryBackendUrl: 'http://marketplace-registry:5071/',
      proxyUrl: 'http://marketplace-tamper:8081/',
    });

    assert.deepEqual(topology, {
      marketplaceSourceUrl: 'http://127.0.0.1:4000/api/v1/marketplace-registry',
      marketplaceProxyUrl: 'http://marketplace-tamper:8081',
      marketplaceGatewayDataPrefix: 'http://127.0.0.1:4000/api/v1/marketplace-registry/api/v1',
      marketplacePublishUrl: 'http://127.0.0.1:4000/api/v1/marketplace-registry/api/v1',
      registryAdvertisedBaseUrl: 'http://127.0.0.1:4000/api/v1/marketplace-registry',
      tamperUpstreamUrl: 'http://marketplace-registry:5071',
    });

    const config = createRegistryJourneyConfig({
      registryUrl: topology.marketplaceSourceUrl,
      signingPublicKey: 'fixture-public-key',
    });
    assert.equal(config.marketplace.sources[0].url, topology.marketplaceSourceUrl);
  });

  it('rejects missing or non-HTTP topology endpoints', () => {
    assert.throws(() => createRegistryJourneyTopology({
      gatewayUrl: 'file:///tmp/gateway',
      registryBackendUrl: 'http://marketplace-registry:5071',
      proxyUrl: 'http://marketplace-tamper:8081',
    }), /must use HTTP or HTTPS/);
    assert.throws(() => createRegistryJourneyTopology({
      gatewayUrl: 'http://127.0.0.1:4000',
      registryBackendUrl: '',
      proxyUrl: 'http://marketplace-tamper:8081',
    }), /registryBackendUrl must be a non-empty URL/);
  });
});
