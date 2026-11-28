export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/e2e-legacy-zod3-settings',
  version: '1.0.0',
  display: {
    name: 'Journey Zod 3 Settings Fixture',
    description: 'Exercises installed plugin settings validation with public Zod 3.25.76',
  },
  configSection: 'legacyZod3',
  settings: {
    defaults: { value: { text: 'saved' } },
    schema: { zod: './dist/settings-schema.mjs#SettingsSchema' },
  },
};
