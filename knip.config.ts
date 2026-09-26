import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // ── Ignore generated / fixture / template files ─────────────────────────────
  ignore: [
    // Test fixtures — intentionally standalone, not imported
    'infra/devkit/fixtures/**',
    // Scaffold templates — referenced by runtime string, not static import
    'infra/devkit/templates/**',
    // Bundler artefacts that Knip cannot trace
    '**/*.config.{mjs,cjs}',
    // Generated tsup bundle stubs
    '**/tsup.config.bundled_*.mjs',
    // Next.js traces
    '**/.next/**',
    // MDX content files — consumed by Next.js file-based routing, not static imports
    'sites/**/content/**/*.{md,mdx}',
    'sites/**/content/**/*.{ts,tsx}',
    // Web copy files (ru/en) — consumed by next-intl at runtime
    'sites/**/web/{ru,en}/**',
    // Plugin Studio pages/components — loaded via Module Federation, not static import
    'plugins/*/studio/src/**',
    // Plugin rspack entries — built separately by rspack, not imported by TS
    'plugins/*/entry/src/**',
    // Module Federation temp files (generated)
    'studio/**/__mf__temp/**',
    // Scaffold templates — loaded by kb-create at runtime via fs.readFile
    'templates/**',
    // release/manager-changelog builtin templates — loaded dynamically via import(templatePath)
    'plugins/release/manager-changelog/src/templates/builtin/**',
    // release/manager-cli studio — loaded via Module Federation (rspack.studio.config.mjs exposes them)
    'plugins/release/manager-cli/src/studio/**',
    // AI review test file (core/types) — not a real test, not imported
    'core/types/src/test-review.ts',
  ],

  ignoreDependencies: [
    // Peer deps used by consumers, not imported directly in source
    'typescript',
    'react',
    'react-dom',
    // Build tooling invoked via CLI, not imported
    'tsup',
    'tsx',
    'vite',
    'vitest',
    '@vitejs/plugin-react',
    // ESLint flat-config plugins loaded by string name in eslint.config.*, not imported
    '@typescript-eslint/eslint-plugin',
    '@typescript-eslint/parser',
    'eslint-plugin-import',
    'eslint-plugin-react',
    'eslint-plugin-react-hooks',
  ],

  // ── Workspace overrides ──────────────────────────────────────────────────────
  workspaces: {
    // ── Root ──
    '.': {
      entry: ['scripts/**/*.{ts,mjs,js}'],
    },

    // ── CLI binary — bin entry + types barrel ──
    'cli/bin': {
      entry: ['src/index.ts', 'src/bin.ts'],
      // tsup configs are build scripts, not source
      ignore: ['tsup.*.config.ts', 'scripts/**'],
      // types/index.ts is an empty barrel stub — fine to flag but not critical
      ignoreDependencies: ['@kb-labs/cli-runtime'],
    },

    // ── CLI commands — all command files are entry points ──
    'cli/commands': {
      entry: ['src/commands/**/*.ts', 'src/index.ts'],
    },

    // ── infra/devkit — every bin/*.mjs is an entry point ──
    'infra/devkit': {
      entry: ['bin/*.mjs', 'src/index.ts', 'vitest/**.{ts,js}'],
      ignore: ['fixtures/**', 'templates/**'],
    },

    // ── Daemon apps — index.ts or bootstrap.ts is the process entry ──
    'services/gateway/app': {
      entry: ['src/index.ts'],
    },
    'services/gateway/runtime-server': {
      entry: ['src/index.ts', 'src/cli.ts'],
    },
    'services/host/app': {
      entry: ['src/index.ts', 'src/bin.ts'],
    },
    'services/rest-api/app': {
      // bootstrap.ts is the real entry; routes/*, middleware/*, events/* are
      // registered via fastify plugin pattern (server.register), not static imports
      entry: ['src/index.ts', 'src/bootstrap.ts', 'src/server.ts'],
    },
    'services/mcp/app': {
      entry: ['src/index.ts', 'src/manifest.ts'],
    },
    'plugins/marketplace/daemon/marketplace': {
      entry: ['src/index.ts', 'src/bootstrap.ts'],
    },
    'plugins/workflow/daemon': {
      // server.ts imports individual API files directly (not via api/index.ts barrel)
      // so api/index.ts is genuinely unused — leave it in results
      entry: ['src/index.ts'],
    },
    'plugins/state/daemon': {
      entry: ['src/index.ts', 'src/bin.ts'],
    },
    'plugins/state/daemon/core-state-daemon': {
      entry: ['src/index.ts', 'src/bin.ts'],
    },
    'plugins/host-agent/app': {
      entry: ['src/index.ts'],
    },
    'plugins/host-agent/app/host-agent-app': {
      entry: ['src/index.ts', 'src/daemon.ts'],
    },

    // ── Studio app — router-driven, pages are entry points ──
    'studio/app': {
      entry: ['src/main.tsx', 'src/index.ts', 'src/modules/*/routes/**/*.{ts,tsx}'],
    },

    // ── mind/engine — has sub-exports (./sync, ./adapters/runtime-adapter) ──
    'plugins/mind/engine': {
      entry: ['src/index.ts', 'src/sync/index.ts', 'src/adapters/runtime-adapter.ts'],
    },

    // ── core/runtime — ipc/transport/proxy sub-paths are loaded dynamically ──
    'core/runtime': {
      entry: [
        'src/index.ts',
        'src/ipc/index.ts',
        'src/transport/index.ts',
        'src/proxy/index.ts',
      ],
    },

    // ── core/sandbox — runner sub-modules spawned dynamically as child processes ──
    'core/sandbox': {
      entry: [
        'src/index.ts',
        'src/runner/*/index.ts',
        'src/diagnostics/crash-reporter.ts',
      ],
    },

    // ── adapters/analytics-duckdb — one-off migration scripts are entry points ──
    'adapters/analytics-duckdb': {
      entry: ['src/index.ts', 'scripts/*.mjs'],
    },

    // ── Sites (Next.js) — app router pages + config files ──
    'sites/*/apps/*': {
      entry: [
        'app/**/*.{ts,tsx}',
        'pages/**/*.{ts,tsx}',
        'src/app/**/*.{ts,tsx}',
        'src/pages/**/*.{ts,tsx}',
        'next.config.{ts,mjs,js}',
        'tailwind.config.{ts,js}',
        'middleware.ts',
      ],
    },

    // ── sdk — type-tests are tsc-only, not vitest ──
    'sdk/sdk': {
      entry: ['src/index.ts'],
      ignore: ['src/__type-tests__/**'],
    },

    // ── shared/cli-ui — cli-auto-discovery is exported via barrel ──
    'shared/cli-ui': {
      entry: ['src/index.ts'],
    },

    // ── plugins/mind/orchestrator — modes/index.ts is exported via barrel ──
    'plugins/mind/orchestrator': {
      entry: ['src/index.ts'],
    },
  },
};

export default config;
