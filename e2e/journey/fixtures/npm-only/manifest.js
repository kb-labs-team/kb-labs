export const manifest = {
  schema: 'kb.plugin/3',
  id: 'journey-npm-only-fixture',
  version: '1.0.0',
  display: {
    name: 'Journey npm fallback fixture',
    description: 'An unscoped plugin used to prove the explicit npm fallback source',
  },
  permissions: { platform: {} },
  platform: { requires: [] },
  cli: { commands: [] },
};
