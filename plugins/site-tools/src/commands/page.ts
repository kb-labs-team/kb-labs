import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { defineCommand, type PluginCommandContextV3, type CLIInput, type CommandResult } from '@kb-labs/sdk';

interface PageFlags {
  badge?: string;
  'dry-run'?: boolean;
}

type PageResult = Record<string, never>;

type JsonObj = { [key: string]: JsonVal };
type JsonVal = string | number | boolean | null | JsonVal[] | JsonObj;

function dotSet(obj: JsonObj, path: string, value: string): void {
  const parts = path.split('.');
  let cur: JsonObj = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    if (cur[key] == null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) {
      cur[key] = {};
    }
    cur = cur[key] as JsonObj;
  }
  const last = parts[parts.length - 1] as string;
  cur[last] = value;
}

function pageTemplate(segment: string, namespace: string): string {
  const routePath = `/${segment}`;
  const words = segment.split(/[-/]/);
  const componentName =
    words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Page';

  return `import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { buildPageMetadata } from '@/lib/page-metadata';

type Props = { params: Promise<{ locale: string }> };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: '${namespace}' });
  return buildPageMetadata({
    locale,
    title: t('meta.title'),
    description: t('meta.description'),
    path: '${routePath}',
    imageSegment: '${segment}',
  });
}

export default async function ${componentName}({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <main>
      {/* TODO: add page content */}
    </main>
  );
}
`;
}

function ogTemplate(segment: string, namespace: string, badge: string): string {
  const displayName = segment.split('/').pop() ?? segment;
  const altText =
    'KB Labs — ' + displayName.charAt(0).toUpperCase() + displayName.slice(1);
  const badgeLine = badge ? `\n    badge: '${badge}',` : '';

  return `import { getTranslations } from 'next-intl/server';
import { renderOgImage, OG_SIZE, OG_CONTENT_TYPE } from '@kb-labs/web-og';

export const alt = '${altText}';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: '${namespace}' });
  return renderOgImage({
    title: t('meta.title'),
    description: t('meta.description'),${badgeLine}
  });
}
`;
}

async function runPage(
  ctx: PluginCommandContextV3,
  input: CLIInput<PageFlags>,
): Promise<CommandResult<PageResult>> {
  const argv = input.argv ?? [];
  const segment = argv.find((a) => !a.startsWith('-'));

  if (!segment) {

    ctx.ui.write(
      'Examples:\n  kb site page create pricing\n  kb site page create solutions/my-solution --badge Solutions\n',
    );
    return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: 'A page segment is required', hint: 'Provide a lowercase route segment, for example `kb site page create pricing`.' } };
  }

  // Reject path traversal — only forward slashes and alphanumeric/hyphen segments allowed
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(segment) || segment.includes('..') || normalize(segment) !== segment) {

    return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: `Invalid segment '${segment}'`, hint: 'Use lowercase letters, numbers, hyphens, and forward slashes without path traversal, then rerun `kb site page create <segment>`.' } };
  }

  const badge = input.flags?.badge ?? '';
  const dryRun = input.flags?.['dry-run'] ?? false;

  const workspaceRoot = ctx.cwd ?? process.cwd();
  const siteRoot = join(workspaceRoot, 'sites', 'web', 'apps', 'web');
  const localeDir = join(siteRoot, 'app', '[locale]');
  const segmentDir = resolve(join(localeDir, segment));

  // Double-check the resolved path is still inside localeDir (defense in depth)
  if (!segmentDir.startsWith(resolve(localeDir) + '/') && segmentDir !== resolve(localeDir)) {

    return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: `Segment '${segment}' resolves outside app/[locale]/`, hint: "Run `kb site page create --help` to review its inputs and recovery steps, then retry." } };
  }

  const namespace = segment
    .split(/[-/]/)
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');

  const pagePath   = join(segmentDir, 'page.tsx');
  const ogPath     = join(segmentDir, 'opengraph-image.tsx');
  const enJsonPath = join(siteRoot, 'messages', 'en.json');
  const ruJsonPath = join(siteRoot, 'messages', 'ru.json');

  if (existsSync(pagePath)) {

    return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: `page.tsx already exists at app/[locale]/${segment}/`, hint: "Run `kb site page create --help` to review its inputs and recovery steps, then retry." } };
  }

  if (existsSync(ogPath)) {

    return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: `opengraph-image.tsx already exists at app/[locale]/${segment}/`, hint: "Run `kb site page create --help` to review its inputs and recovery steps, then retry." } };
  }

  const pageContent = pageTemplate(segment, namespace);
  const ogContent   = ogTemplate(segment, namespace, badge);
  const titleStub   = 'TODO: 15–65 chars — Page Title — KB Labs';
  const descStub    = 'TODO: 70–165 chars — Describe what this page is about and why it matters.';

  if (!dryRun) {
    mkdirSync(segmentDir, { recursive: true });
    writeFileSync(pagePath, pageContent, 'utf8');
    writeFileSync(ogPath, ogContent, 'utf8');

    for (const jsonPath of [enJsonPath, ruJsonPath]) {
      const messages = JSON.parse(readFileSync(jsonPath, 'utf8')) as JsonObj;
      dotSet(messages, `${namespace}.meta.title`, titleStub);
      dotSet(messages, `${namespace}.meta.description`, descStub);
      writeFileSync(jsonPath, JSON.stringify(messages, null, 2) + '\n', 'utf8');
    }
  }

  const prefix = dryRun ? '[dry-run] would create' : 'Created';

  ctx.ui.success(`${prefix} page '${segment}'`, {
    title: 'site page create',
    sections: [
      {
        header: 'Files',
        items: [
          `app/[locale]/${segment}/page.tsx`,
          `app/[locale]/${segment}/opengraph-image.tsx`,
          `messages/en.json  (key: ${namespace}.meta.{title,description})`,
          `messages/ru.json  (key: ${namespace}.meta.{title,description})`,
        ],
      },
      {
        header: 'Next steps',
        items: [
          `Fill in ${namespace}.meta.title and .description in messages/en.json + ru.json`,
          `Add page content to app/[locale]/${segment}/page.tsx`,
          `Add to sitemap.ts: { path: '/${segment}', priority: 0.7, changeFrequency: 'monthly' }`,
        ],
      },
    ],
  });

  return {};
}

export default defineCommand({
  id: 'site-tools:page',
  description: 'Scaffold a new marketing site page with SEO defaults',
  handler: { execute: runPage },
});
