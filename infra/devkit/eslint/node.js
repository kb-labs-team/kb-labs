
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import'
import unusedImports from 'eslint-plugin-unused-imports'
import sonarjs from 'eslint-plugin-sonarjs'
import noUnusedExportedParameters from './rules/no-unused-exported-parameters.js'

export default [
  // ---- ignore common build artifacts and generated files
  {
    ignores: [
      '/dist/',
      '/coverage/',
      '/.yalc/',
      '/node_modules/',
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/scripts/**',
      '**/eslint.config.*',
      '**/tsup.config.*',
      '**/bootstrap.js',
      '**/tsup.config.bundled_*.mjs'
    ]
  },

  // ---- base TypeScript recommendations
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: { projectService: true },
    },
  },

  // ---- project-wide rules and import resolver
  {
    plugins: {
      import: importPlugin,
      'unused-imports': unusedImports,
      sonarjs: sonarjs,
      'kb-labs': {
        rules: {
          'no-unused-exported-parameters': noUnusedExportedParameters,
        },
      },
    },
    settings: {
      // Let eslint-plugin-import resolve TS paths and packages without extensions
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['./tsconfig.json'],
        },
      },
    },
    languageOptions: {
      // Basic TypeScript parsing without requiring project setup
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // Allow bare imports without file extensions for TS/JS in ESM projects
      'import/extensions': ['error', 'ignorePackages', {
        ts: 'never', tsx: 'never', mts: 'never', cts: 'never',
        js: 'never', mjs: 'never', cjs: 'never',
      }],

      // Allow dev dependencies in tests, configs and scripts
      'import/no-extraneous-dependencies': ['error', {
        devDependencies: [
          '**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts}',
          '**/__tests__/**',
          '**/vite.config.*',
          '**/vitest.config.*',
          '**/tsup*.config.*',
          '**/eslint.config.*',
          '**/scripts/**',
        ],
      }],

      // TS ergonomics - disable base rule, use unused-imports instead
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'kb-labs/no-unused-exported-parameters': 'error',
      'unused-imports/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],

      // Async/Promise safety (non-type-aware rules only)
      // Note: @typescript-eslint/no-floating-promises requires project setup
      'no-return-await': 'error',
      'no-promise-executor-return': 'error',
      // no-await-in-loop: off globally (too noisy for CLI/fs code).
      // Enable per-repo where it matters (rest-api, workflow).
      'no-await-in-loop': 'off',

      // Security
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // General safety / clarity
      'no-console': 'off',
      'no-debugger': 'warn',
      'eqeqeq': ['error', 'smart'],
      'curly': ['error', 'all'],
      'no-throw-literal': 'error',
      'prefer-const': 'error',
      'no-var': 'error',

      // SonarJS rules (code quality & bug detection)
      'sonarjs/no-duplicate-string': ['warn', { threshold: 5 }],
      'sonarjs/cognitive-complexity': ['warn', 15],
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/no-collapsible-if': 'warn',
      'sonarjs/no-redundant-boolean': 'warn',
      'sonarjs/prefer-immediate-return': 'warn',
    },
  },

  // ---- minimal .vue support (without forcing Vue plugin)
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { extraFileExtensions: ['.vue'] },
    },
  },

  // ---- test file overrides
  {
    files: [
      '**/*.{test,spec}.{ts,tsx,js,jsx}',
      '**/__tests__/**/*.{ts,tsx,js,jsx}',
    ],
    rules: {
      // Disable duplicate string detection in tests - test literals should be inline for readability
      'sonarjs/no-duplicate-string': 'off',
    },
  },
]
