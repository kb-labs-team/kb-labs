export const manifest = {
  schema: 'kb.plugin/3',
  id: 'fixture-compat',
  version: '1.0.0',
  display: {
    name: 'Update Compatibility Fixture',
    description: 'Journey plugin whose package identity is used by update compatibility checks',
  },
  permissions: { platform: {} },
  platform: { requires: [] },
  compatibility: { platformRange: '<3.2.0' },
  cli: { commands: [] },
};
