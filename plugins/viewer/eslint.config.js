import reactPreset from '@kb-labs/devkit/eslint/react.js';

export default [
  ...reactPreset,
  {
    files: ['src/studio/**/*.tsx'],
    languageOptions: {
      globals: {
        atob: 'readonly',
      },
    },
  },
];
