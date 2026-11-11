import type {
  ManifestPatch,
  ManifestSnippets,
} from '@kb-labs/scaffold-contracts';

/**
 * Emit a TypeScript source file for the plugin V3 manifest.
 *
 * The manifest object is stringified as a JSON literal. A `permissions`
 * expression is assembled from `combinePermissions()` snippets contributed
 * by blocks and spread in alongside. Imports are deduped at the top.
 */
export function emitManifest(
  manifest: ManifestPatch,
  snippets: ManifestSnippets,
): string {
  const importLines = [...(snippets.imports ?? [])];
  const hasCombine = importLines.some((l) =>
    /\bcombinePermissions\b/.test(l),
  );
  if (!hasCombine) {
    importLines.unshift(
      "import { combinePermissions } from '@kb-labs/sdk';",
    );
  }
  const importSet = new Set<string>(importLines);

  const permLines = snippets.permissions ?? [];
  const permExpr =
    permLines.length > 0
      ? `combinePermissions()\n  ${permLines.map((l) => `.${l}`).join('\n  ')}\n  .build()`
      : 'combinePermissions().build()';

  const body = JSON.stringify(manifest, null, 2);

  return `/**
 * V3 plugin manifest. Scaffolded by @kb-labs/scaffold.
 *
 * Edit freely — this is your plugin's public surface. Add commands by
 * appending to \`cli.commands[]\`, REST routes under \`rest.routes[]\`,
 * Studio pages under \`studio\`. Consult neighbouring plugins
 * (\`plugins/commit\`, \`plugins/review\`) for reference shapes.
 */
${[...importSet].join('\n')}

const permissions = ${permExpr};

const baseManifest = ${body} as const;

export const manifest: typeof baseManifest & { permissions: unknown } = { ...baseManifest, permissions };
`;
}
