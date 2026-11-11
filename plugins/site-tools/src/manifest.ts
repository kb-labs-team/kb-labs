import { combinePermissions, kbPlatformPreset } from '@kb-labs/sdk';

const permissions = combinePermissions()
  .with(kbPlatformPreset)
  .withFs({
    mode: 'readWrite',
    allow: [
      'sites/web/apps/web/app/[locale]/**',
      'sites/web/apps/web/messages/*.json',
    ],
  })
  .withQuotas({ timeoutMs: 30000, memoryMb: 128 })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/site-tools',
  version: '0.1.0',
  display: {
    name: 'Site Tools',
    description: 'Developer tools for the KB Labs marketing site',
    tags: ['site', 'scaffold', 'seo', 'dx'],
  },
  cli: {
    groupMeta: [
      { path: 'site', describe: 'Marketing site developer tools' },
    ],
    commands: [
      {
        path: 'site page create',
        describe: 'Scaffold a new site page with SEO defaults (page.tsx + opengraph-image.tsx + i18n stubs)',
        handler: './commands/page.js#default',
        flags: [
          {
            name: 'badge',
            type: 'string',
            description: 'Badge text shown on the OG image (e.g. "Product", "Solutions")',
          },
          {
            name: 'dry-run',
            type: 'boolean',
            description: 'Preview what would be created without writing files',
          },
        ],
        examples: [
          'kb site page create pricing — create /pricing page',
          'kb site page create solutions/my-solution --badge Solutions — create a solutions sub-page',
          'kb site page create new-feature --dry-run — preview without writing',
        ],
      },
    ],
  },
  permissions,
};
