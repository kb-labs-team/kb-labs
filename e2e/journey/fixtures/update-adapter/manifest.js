export const manifest = {
  schema: 'kb.adapter/1',
  manifestVersion: '1.0.0',
  id: 'fixture-adapter',
  name: 'Update Compatibility Fixture Adapter',
  version: '1.0.0',
  description: 'Journey adapter whose package identity is used by update compatibility checks',
  type: 'extension',
  implements: 'IStorage',
  networkRequired: false,
  compatibility: { platformRange: '<3.2.0' },
};
