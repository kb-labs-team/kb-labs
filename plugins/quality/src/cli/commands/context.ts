import {
  defineCommand,
  useConfig,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import { scanWorkspace, buildPackageMap } from '../../core/index.js';
import { defaultQualityConfig, type QualityPluginConfig } from '../../contracts/index.js';
import type { ContextFlags } from './flags.js';

const LAYER_NAMES: Record<number, string> = {
  0: 'core',
  1: 'sdk / shared',
  2: 'cli / adapters',
  3: 'plugins',
  4: 'studio',
};

export default defineCommand<unknown, CLIInput<ContextFlags>, unknown>({
  id: 'quality:context',
  description: 'Package context for agents: layer, dependents, dependencies, coupling',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<ContextFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QualityPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();
      const layerMap = config?.layers ?? defaultQualityConfig.layers;

      const packages = scanWorkspace(cwd, layerMap);
      const packageMap = buildPackageMap(packages);
      const allNames = new Set(packageMap.keys());

      const pkgName = flags.package;

      if (!pkgName) {
        // No package specified — show workspace summary
        const byLayer = new Map<number, string[]>();
        for (const p of packages) {
          const list = byLayer.get(p.layer) ?? [];
          list.push(p.name);
          byLayer.set(p.layer, list);
        }

        if (flags.json) {
          const summary = Object.fromEntries(
            [...byLayer.entries()].map(([l, names]) => [LAYER_NAMES[l] ?? `layer-${l}`, names])
          );
          return { totalPackages: packages.length, byLayer: summary };
        }

        const sections = [...byLayer.entries()]
          .sort(([a], [b]) => a - b)
          .map(([layer, names]) => ({
            header: `Layer ${layer}: ${LAYER_NAMES[layer] ?? 'unknown'} (${names.length})`,
            items: names,
          }));

        ctx.ui?.success?.(`Workspace: ${packages.length} packages`, { sections });
        return {  };
      }

      const pkg = packageMap.get(pkgName);
      if (!pkg) {

        return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: `Package not found: ${pkgName}`, hint: 'Check the package name, then rerun `kb quality context show --package <name>`.' } };
      }

      // Workspace deps (efferent)
      const wsDeps = pkg.deps.filter(d => allNames.has(d));
      const wsDevDeps = pkg.devDeps.filter(d => allNames.has(d));

      // Who depends on this package (afferent) — scan all packages
      const dependents = packages
        .filter(p => p.name !== pkgName && (p.deps.includes(pkgName) || p.devDeps.includes(pkgName)))
        .map(p => p.name);

      const ce = wsDeps.length + wsDevDeps.length;
      const ca = dependents.length;
      const instability = ca + ce === 0 ? 0 : Math.round((ce / (ca + ce)) * 100) / 100;

      const context = {
        name: pkgName,
        layer: pkg.layer,
        layerName: LAYER_NAMES[pkg.layer] ?? 'unknown',
        dir: pkg.dir.replace(cwd + '/', ''),
        coupling: { afferent: ca, efferent: ce, instability },
        dependents,
        dependencies: wsDeps,
        devDependencies: wsDevDeps,
      };

      if (flags.json) {
        return context;
      }

      ctx.ui?.success?.(`Context: ${pkgName}`, {
        sections: [
          {
            header: 'Package info',
            items: [
              `Layer: ${pkg.layer} (${LAYER_NAMES[pkg.layer] ?? 'unknown'})`,
              `Dir: ${context.dir}`,
              `Instability: ${instability}  Ca: ${ca}  Ce: ${ce}`,
            ],
          },
          ...(dependents.length > 0
            ? [{ header: `Dependents (${ca}) — packages that import this`, items: dependents }]
            : [{ header: 'Dependents', items: ['none — this package is a leaf'] }]),
          ...(wsDeps.length > 0
            ? [{ header: `Dependencies (${wsDeps.length}) — workspace packages this imports`, items: wsDeps }]
            : []),
          ...(wsDevDeps.length > 0
            ? [{ header: `Dev dependencies (${wsDevDeps.length})`, items: wsDevDeps }]
            : []),
        ],
      });

      return {  };
    },
  },
});
