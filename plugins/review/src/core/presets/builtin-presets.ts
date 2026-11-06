/**
 * @module @kb-labs/review/core/presets/builtin-presets
 * Built-in preset definitions
 */

/* eslint-disable sonarjs/no-duplicate-string -- Preset definitions intentionally share common patterns (eslint:recommended, node_modules, dist, build) across multiple presets */

import type { PresetDefinition } from '../../contracts/index.js';

/**
 * Default preset - balanced rules for most projects
 */
const defaultPreset: PresetDefinition = {
  id: 'default',
  name: 'Default',
  description: 'Balanced rules for most TypeScript/JavaScript projects',

  rules: [
    'eslint:recommended',
    '@typescript-eslint/recommended',
  ],

  excludeRules: [],

  engines: {
    eslint: {
      enabled: true,
      config: {
        parser: '@typescript-eslint/parser',
        parserOptions: {
          ecmaVersion: 2022,
          sourceType: 'module',
        },
        plugins: ['@typescript-eslint'],
        rules: {
          // Warnings for common issues
          '@typescript-eslint/no-explicit-any': 'warn',
          '@typescript-eslint/no-unused-vars': ['warn', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
          }],
          'no-console': 'warn',
          'no-debugger': 'error',
        },
      },
    },
  },

  include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
};

/**
 * TypeScript Strict preset - strict type checking and best practices
 */
const typescriptStrictPreset: PresetDefinition = {
  id: 'typescript-strict',
  name: 'TypeScript Strict',
  description: 'Strict TypeScript rules with @typescript-eslint/recommended',

  rules: [
    'eslint:recommended',
    '@typescript-eslint/recommended',
    '@typescript-eslint/recommended-requiring-type-checking',
  ],

  excludeRules: [],

  engines: {
    eslint: {
      enabled: true,
      config: {
        parser: '@typescript-eslint/parser',
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          project: true,
        },
        extends: [
          'eslint:recommended',
          'plugin:@typescript-eslint/recommended',
          'plugin:@typescript-eslint/recommended-requiring-type-checking',
        ],
        rules: {
          '@typescript-eslint/no-explicit-any': 'error',
          '@typescript-eslint/explicit-function-return-type': 'warn',
          '@typescript-eslint/no-unused-vars': 'error',
          '@typescript-eslint/strict-boolean-expressions': 'warn',
        },
      },
    },
  },

  include: ['**/*.ts', '**/*.tsx'],
  exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.test.ts', '**/*.spec.ts'],

  severity: {
    failOn: 'high',
  },
};

/**
 * React preset - React-specific rules
 */
const reactPreset: PresetDefinition = {
  id: 'react',
  name: 'React',
  description: 'React best practices with hooks rules',

  rules: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],

  excludeRules: [],

  engines: {
    eslint: {
      enabled: true,
      config: {
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ecmaFeatures: {
            jsx: true,
          },
        },
        extends: [
          'eslint:recommended',
          'plugin:react/recommended',
          'plugin:react-hooks/recommended',
        ],
        settings: {
          react: {
            version: 'detect',
          },
        },
        rules: {
          'react/react-in-jsx-scope': 'off', // Not needed in React 17+
          'react-hooks/rules-of-hooks': 'error',
          'react-hooks/exhaustive-deps': 'warn',
        },
      },
    },
  },

  include: ['**/*.tsx', '**/*.jsx'],
  exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
};

/**
 * Security preset - security-focused rules
 */
const securityPreset: PresetDefinition = {
  id: 'security',
  name: 'Security',
  description: 'Security-focused rules to detect vulnerabilities',

  rules: [
    'eslint:recommended',
    'plugin:security/recommended',
  ],

  excludeRules: [],

  engines: {
    eslint: {
      enabled: true,
      config: {
        extends: [
          'eslint:recommended',
          'plugin:security/recommended',
        ],
        rules: {
          'no-eval': 'error',
          'no-implied-eval': 'error',
          'no-new-func': 'error',
          'security/detect-eval-with-expression': 'error',
          'security/detect-non-literal-regexp': 'warn',
          'security/detect-unsafe-regex': 'error',
        },
      },
    },
  },

  include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],

  severity: {
    failOn: 'medium',
  },
};

/**
 * KB Labs preset - comprehensive rules for KB Labs monorepo
 */
const kbLabsPreset: PresetDefinition = {
  id: 'kb-labs',
  name: 'KB Labs',
  description: 'Comprehensive architectural and security rules for KB Labs platform',

  rules: [
    'eslint:recommended',
    '@typescript-eslint/recommended',
  ],

  excludeRules: [],

  engines: {
    eslint: {
      enabled: true,
      config: {
        parser: '@typescript-eslint/parser',
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          project: true,
        },
        plugins: ['@typescript-eslint', 'security'],
        rules: {
          // Type Safety
          '@typescript-eslint/no-explicit-any': 'error',
          '@typescript-eslint/no-unsafe-assignment': 'warn',
          '@typescript-eslint/no-unsafe-member-access': 'warn',
          '@typescript-eslint/no-unsafe-call': 'warn',
          '@typescript-eslint/no-unsafe-return': 'warn',

          // Naming Conventions
          '@typescript-eslint/naming-convention': [
            'error',
            {
              selector: 'interface',
              format: ['PascalCase'],
              prefix: ['I'],
            },
            {
              selector: 'typeAlias',
              format: ['PascalCase'],
            },
            {
              selector: 'class',
              format: ['PascalCase'],
            },
            {
              selector: 'function',
              format: ['camelCase', 'PascalCase'],
            },
            {
              selector: 'variable',
              format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
              leadingUnderscore: 'allow',
            },
          ],

          // Code Quality
          '@typescript-eslint/no-unused-vars': ['error', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrors: 'all',
          }],
          '@typescript-eslint/explicit-function-return-type': ['warn', {
            allowExpressions: true,
            allowTypedFunctionExpressions: true,
            allowHigherOrderFunctions: true,
          }],
          '@typescript-eslint/no-floating-promises': 'error',
          '@typescript-eslint/await-thenable': 'error',
          '@typescript-eslint/no-misused-promises': 'error',

          // Security
          'no-eval': 'error',
          'no-implied-eval': 'error',
          'no-new-func': 'error',
          'security/detect-eval-with-expression': 'error',
          'security/detect-non-literal-regexp': 'warn',
          'security/detect-unsafe-regex': 'error',
          'security/detect-buffer-noassert': 'error',
          'security/detect-child-process': 'warn',
          'security/detect-disable-mustache-escape': 'error',
          'security/detect-no-csrf-before-method-override': 'error',
          'security/detect-non-literal-fs-filename': 'warn',
          'security/detect-non-literal-require': 'warn',
          'security/detect-object-injection': 'warn',
          'security/detect-possible-timing-attacks': 'warn',
          'security/detect-pseudoRandomBytes': 'error',

          // Best Practices
          'no-console': ['warn', { allow: ['warn', 'error'] }],
          'no-debugger': 'error',
          'no-alert': 'error',
          'prefer-const': 'error',
          'no-var': 'error',
          'eqeqeq': ['error', 'always', { null: 'ignore' }],
        },
      },
    },
  },

  // LLM Analyzers context
  context: {
    projectType: 'monorepo',
    framework: 'nodejs',
    language: 'typescript',
    conventions: {
      naming: 'Interfaces must be prefixed with I (e.g., ILLM, ICache). Classes use PascalCase. Functions and variables use camelCase.',
      architecture: 'Follow V3 plugin system patterns. Use adapter pattern for external services. Implement proper error handling with typed errors.',
      security: 'Never use eval() or Function(). Validate all external inputs. Use parameterized queries. Sanitize file paths.',
    },
    adrs: [
      'ADR-0046: LLM Router for tier-based model selection',
      'ADR-0048: Metadata-based routing with wrapper chain',
      'ADR-0047: Multi-adapter architecture',
    ],
  },

  include: ['**/packages/*/src/**/*.ts', '**/packages/*/src/**/*.tsx'],
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/__tests__/**',
  ],

  severity: {
    failOn: 'high',
  },
};

/**
 * KB Labs Strict preset - maximum strictness for critical packages
 */
const kbLabsStrictPreset: PresetDefinition = {
  id: 'kb-labs-strict',
  name: 'KB Labs Strict',
  description: 'Maximum strictness for security-critical packages (core, runtime, plugin-runtime)',

  rules: [
    'eslint:recommended',
    '@typescript-eslint/recommended',
    '@typescript-eslint/recommended-requiring-type-checking',
  ],

  excludeRules: [],

  engines: {
    eslint: {
      enabled: true,
      config: {
        parser: '@typescript-eslint/parser',
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          project: true,
        },
        plugins: ['@typescript-eslint', 'security'],
        rules: {
          // Type Safety - STRICT
          '@typescript-eslint/no-explicit-any': 'error',
          '@typescript-eslint/no-unsafe-assignment': 'error',
          '@typescript-eslint/no-unsafe-member-access': 'error',
          '@typescript-eslint/no-unsafe-call': 'error',
          '@typescript-eslint/no-unsafe-return': 'error',
          '@typescript-eslint/explicit-function-return-type': 'error',
          '@typescript-eslint/explicit-module-boundary-types': 'error',
          '@typescript-eslint/strict-boolean-expressions': 'error',
          '@typescript-eslint/no-non-null-assertion': 'error',

          // Naming Conventions - STRICT
          '@typescript-eslint/naming-convention': [
            'error',
            {
              selector: 'interface',
              format: ['PascalCase'],
              prefix: ['I'],
            },
            {
              selector: 'typeAlias',
              format: ['PascalCase'],
            },
            {
              selector: 'class',
              format: ['PascalCase'],
            },
            {
              selector: 'function',
              format: ['camelCase'],
            },
            {
              selector: 'variable',
              format: ['camelCase', 'UPPER_CASE'],
              leadingUnderscore: 'forbid',
            },
          ],

          // Code Quality - STRICT
          '@typescript-eslint/no-unused-vars': ['error', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrors: 'all',
            ignoreRestSiblings: false,
          }],
          '@typescript-eslint/no-floating-promises': 'error',
          '@typescript-eslint/await-thenable': 'error',
          '@typescript-eslint/no-misused-promises': 'error',
          '@typescript-eslint/require-await': 'error',
          '@typescript-eslint/no-unnecessary-type-assertion': 'error',

          // Security - MAXIMUM
          'no-eval': 'error',
          'no-implied-eval': 'error',
          'no-new-func': 'error',
          'security/detect-eval-with-expression': 'error',
          'security/detect-non-literal-regexp': 'error',
          'security/detect-unsafe-regex': 'error',
          'security/detect-buffer-noassert': 'error',
          'security/detect-child-process': 'error',
          'security/detect-disable-mustache-escape': 'error',
          'security/detect-no-csrf-before-method-override': 'error',
          'security/detect-non-literal-fs-filename': 'error',
          'security/detect-non-literal-require': 'error',
          'security/detect-object-injection': 'error',
          'security/detect-possible-timing-attacks': 'error',
          'security/detect-pseudoRandomBytes': 'error',

          // Best Practices - STRICT
          'no-console': 'error',
          'no-debugger': 'error',
          'no-alert': 'error',
          'prefer-const': 'error',
          'no-var': 'error',
          'eqeqeq': ['error', 'always'],
          'no-param-reassign': 'error',
        },
      },
    },
  },

  // LLM Analyzers context - STRICT
  context: {
    projectType: 'monorepo',
    framework: 'nodejs',
    language: 'typescript',
    conventions: {
      naming: 'Strict naming: Interfaces MUST have I prefix. NO leading underscores. Constants MUST be UPPER_CASE.',
      architecture: 'V3 plugin system with strict separation of concerns. ALL functions must have explicit return types. NO any types allowed.',
      security: 'Zero tolerance for security issues. ALL inputs must be validated. ALL promises must be awaited or explicitly handled. NO eval/Function/console allowed.',
    },
    adrs: [
      'ADR-0046: LLM Router',
      'ADR-0048: Metadata-based routing',
      'ADR-0047: Multi-adapter architecture',
      'Security: Sandbox isolation with hardcoded deny patterns',
      'Security: Permission-based file system access',
    ],
  },

  include: [
    '**/packages/core-*/src/**/*.ts',
    '**/packages/plugin-runtime/src/**/*.ts',
    '**/packages/state-*/src/**/*.ts',
  ],
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/__tests__/**',
  ],

  severity: {
    failOn: 'medium',
  },
};

/**
 * All built-in presets
 */
export const builtinPresets: PresetDefinition[] = [
  defaultPreset,
  typescriptStrictPreset,
  reactPreset,
  securityPreset,
  kbLabsPreset,
  kbLabsStrictPreset,
];
