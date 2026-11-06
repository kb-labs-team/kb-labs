/** @type {Record<string, import('./types.js').ReleaseFlowPolicy>} */
export const platformFlowPolicies = {
  platform: {
    deliveryTargets: {
      local: {
        registry: 'http://127.0.0.1:4873',
        kind: 'test',
      },
      canary: {
        registry: 'https://npm.kblabs.ru',
        kind: 'test',
      },
      npm: {
        registry: 'https://registry.npmjs.org',
        kind: 'public',
      },
    },
    gatePolicy: {
      canary: { policy: 'none' },
      stable: { policy: 'release-cases' },
    },
    channelDeliveryTargets: {
      canary: 'local',
      stable: 'npm',
    },
  },
};
