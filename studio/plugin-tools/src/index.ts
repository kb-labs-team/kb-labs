/**
 * @kb-labs/studio-plugin-tools
 *
 * Build tooling for plugin Studio pages (Module Federation remotes).
 * Uses Rspack with @module-federation/enhanced for native MF support.
 *
 * @example
 * ```typescript
 * // rspack.studio.config.ts
 * const { createStudioRemoteConfig } = require('@kb-labs/studio-plugin-tools');
 *
 * module.exports = createStudioRemoteConfig({
 *   name: 'commitPlugin',
 *   exposes: {
 *     './CommitOverview': './src/studio/pages/CommitOverview.tsx',
 *   },
 * });
 * ```
 */

/**
 * Shared dependencies that match the Studio host.
 * Loaded once by the host — remotes reuse them via MF shared scope.
 */
export const STUDIO_SHARED_DEPS: Record<string, { singleton: boolean; requiredVersion: string }> = {
  react: { singleton: true, requiredVersion: '^19.0.0' },
  'react-dom': { singleton: true, requiredVersion: '^19.0.0' },
  'react-router-dom': { singleton: true, requiredVersion: '^7.0.0' },
  antd: { singleton: true, requiredVersion: '^5.21.0' },
  '@ant-design/icons': { singleton: true, requiredVersion: '^5.4.0' },
  '@tanstack/react-query': { singleton: true, requiredVersion: '^5.0.0' },
  zustand: { singleton: true, requiredVersion: '^5.0.0' },
  '@kb-labs/studio-hooks': { singleton: true, requiredVersion: '^2.0.0' },
  '@kb-labs/studio-event-bus': { singleton: true, requiredVersion: '^2.0.0' },
  '@kb-labs/studio-ui-kit': { singleton: true, requiredVersion: '^2.0.0' },
  '@kb-labs/studio-ui-core': { singleton: true, requiredVersion: '^2.0.0' },
  '@kb-labs/sdk': { singleton: true, requiredVersion: '^2.0.0' },
};

export const STUDIO_WIDGET_OUTPUT_DIR = 'dist/widgets';

export interface KbStudioRemoteOptions {
  /** Module Federation remote name (must match manifest remoteName) */
  name: string;
  /** Exposed modules: { './PageName': './src/studio/pages/PageName.tsx' } */
  exposes: Record<string, string>;
  /** Override or extend shared deps */
  shared?: Record<string, { singleton?: boolean; requiredVersion?: string }>;
  /** Remote entry filename (default: 'remoteEntry.js') */
  filename?: string;
  /** Output directory (default: 'dist/widgets') */
  outputDir?: string;
  /**
   * Generate TypeScript types for exposed modules (MF v2 dts feature).
   * Studio host picks them up automatically in dev via @mf-types/.
   * Default: true in development, false in production.
   */
  dts?: boolean;
}

/**
 * Create a complete Rspack config for building a plugin as an MF remote.
 *
 * Returns a full rspack config object — use as default export in rspack.config.mjs.
 * Uses dynamic import internally to avoid CJS/ESM issues.
 */
/**
 * Validate React version in the calling plugin's node_modules.
 * Studio host uses React 18 — React 19 causes MF element type mismatch at runtime.
 */
async function validateReactVersion(resolve: (id: string) => string): Promise<void> {
  const fs = await import('fs');

  const reactVersion = await (async (): Promise<string | null> => {
    try {
      const reactPkgPath = resolve('react/package.json');
      const reactPkg = JSON.parse(fs.readFileSync(reactPkgPath, 'utf8')) as { version: string };
      return reactPkg.version ?? null;
    } catch {
      return null;
    }
  })();

  if (!reactVersion) {return;}

  const majorStr = reactVersion.split('.').at(0) ?? '0';
  const major = parseInt(majorStr, 10);
  if (major >= 20) {
    throw new Error(
      `\n\n❌ Studio plugin build failed: React ${reactVersion} detected.\n\n` +
      `Studio host runs React 19. When a plugin bundles React 20+, elements may\n` +
      `use a different internal symbol which React 19 cannot reconcile,\n` +
      `causing "Objects are not valid as a React child" crash at runtime.\n\n` +
      `Fix: pin React 19 in your plugin's devDependencies:\n\n` +
      `  "devDependencies": {\n` +
      `    "react": "^19.0.0",\n` +
      `    "react-dom": "^19.0.0"\n` +
      `  }\n\n` +
      `Then reinstall and rebuild:\n\n` +
      `  pnpm install\n` +
      `  pnpm build:studio\n`,
    );
  }
}

export async function createStudioRemoteConfig(options: KbStudioRemoteOptions): Promise<Record<string, unknown>> {
  const { ModuleFederationPlugin } = await import('@module-federation/enhanced/rspack');
  const path = await import('path');
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);

  await validateReactVersion(require.resolve);

  const isDev = process.env.NODE_ENV !== 'production';
  const outputDir = options.outputDir ?? STUDIO_WIDGET_OUTPUT_DIR;
  const enableDts = options.dts ?? isDev;

  return {
    entry: {},
    output: {
      path: path.resolve(process.cwd(), outputDir),
      publicPath: 'auto',
      clean: true,
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.jsx', '.js'],
      extensionAlias: {
        '.js': ['.ts', '.tsx', '.js'],
      },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: {
            loader: 'builtin:swc-loader',
            options: {
              jsc: {
                parser: { syntax: 'typescript', tsx: true },
                transform: { react: { runtime: 'automatic' } },
              },
            },
          },
        },
        {
          test: /\.module\.css$/,
          use: [
            require.resolve('style-loader'),
            {
              loader: require.resolve('css-loader'),
              options: {
                // Explicit rather than relying on css-loader's version-dependent
                // default — keeps class name casing consistent with the Studio
                // host's native Rspack CSS Modules (studio/app/rspack.config.mjs,
                // `exportsConvention: 'as-is'`) and with the tsup CSS Modules
                // plugin used by library packages like ui-kit
                // (infra/devkit/tsup/css-modules-plugin.js).
                modules: { exportLocalsConvention: 'as-is' },
              },
            },
          ],
        },
        {
          test: /\.css$/,
          exclude: /\.module\.css$/,
          use: [require.resolve('style-loader'), require.resolve('css-loader')],
        },
      ],
    },
    plugins: [
      new ModuleFederationPlugin({
        name: options.name,
        filename: options.filename ?? 'remoteEntry.js',
        manifest: true,
        dts: enableDts ? { generateTypes: true } : false,
        exposes: options.exposes,
        shared: {
          ...STUDIO_SHARED_DEPS,
          ...options.shared,
        },
      }),
    ],
    optimization: {
      minimize: true,
    },
  };
}
