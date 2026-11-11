import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  fileURLToPath(import.meta.url),
  '../../../../../../../sites/web/apps/web/scripts/seo-check.mjs',
);

// ─── fixture helpers ───────────────────────────────────────────────────────

function runDevkit(dir: string): { issues: Array<{ check: string; severity: string; message: string }> } {
  const result = spawnSync('node', [SCRIPT], {
    env: {
      ...process.env,
      KB_DEVKIT_MODE: '1',
      KB_DEVKIT_PACKAGE_NAME: '@kb-labs/web-site',
      KB_DEVKIT_PACKAGE_DIR: dir,
    },
    encoding: 'utf8',
  });
  return JSON.parse(result.stdout) as ReturnType<typeof runDevkit>;
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'seo-check-'));
  mkdirSync(join(root, 'app', '[locale]'), { recursive: true });
  mkdirSync(join(root, 'messages'), { recursive: true });
  writeFileSync(join(root, 'messages', 'en.json'), JSON.stringify({
    pricing: {
      meta: {
        title: 'Pricing and Plans — KB Labs',
        description: 'Compare KB Labs pricing tiers and find the plan that fits your team and workflow.',
      },
    },
  }));
  writeFileSync(join(root, 'messages', 'ru.json'), JSON.stringify({
    pricing: {
      meta: {
        title: 'Цены и планы — KB Labs',
        description: 'Сравните тарифы KB Labs и выберите план, подходящий для вашей команды.',
      },
    },
  }));
  return root;
}

function writePageFile(root: string, segment: string, content: string): void {
  const dir = join(root, 'app', '[locale]', segment);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'page.tsx'), content);
}

function writeOgFile(root: string, segment: string, content: string): void {
  const dir = join(root, 'app', '[locale]', segment);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'opengraph-image.tsx'), content);
}

const GOOD_PAGE = `
import { buildPageMetadata } from '@/lib/page-metadata';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'pricing' });
  return buildPageMetadata({
    locale,
    title: t('meta.title'),
    description: t('meta.description'),
    path: '/pricing',
    imageSegment: 'pricing',
  });
}

export default function PricingPage() {
  return <main />;
}
`;

const GOOD_OG = `
import { getTranslations } from 'next-intl/server';
import { renderOgImage, OG_SIZE, OG_CONTENT_TYPE } from '@kb-labs/web-og';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export default async function OpengraphImage({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'pricing' });
  return renderOgImage({ title: t('meta.title'), description: t('meta.description') });
}
`;

// ─── tests ────────────────────────────────────────────────────────────────

let root: string;

beforeEach(() => {
  root = setup();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('seo-check devkit mode', () => {
  it('CHECK-00: self-filter — wrong package name → empty issues', () => {
    writePageFile(root, 'pricing', 'export default function P() { return null; }');

    const result = spawnSync('node', [SCRIPT], {
      env: {
        ...process.env,
        KB_DEVKIT_MODE: '1',
        KB_DEVKIT_PACKAGE_NAME: '@kb-labs/other-package',
        KB_DEVKIT_PACKAGE_DIR: root,
      },
      encoding: 'utf8',
    });
    const out = JSON.parse(result.stdout) as { issues: unknown[] };
    expect(out.issues).toHaveLength(0);
    expect(result.status).toBe(0);
  });

  it('CHECK-01: NO_METADATA — page.tsx without generateMetadata or export const metadata', () => {
    writePageFile(root, 'pricing', 'export default function PricingPage() { return null; }');

    const { issues } = runDevkit(root);
    const hit = issues.find(i => i.message.includes('NO_METADATA'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
  });

  it('CHECK-01: page with export const metadata is accepted (no NO_METADATA)', () => {
    writePageFile(root, 'pricing', 'export const metadata = { title: "Pricing" };\nexport default function P() { return null; }');

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('NO_METADATA'))).toBe(false);
  });

  it('CHECK-02: NO_SEGMENT — buildPageMetadata without imageSegment', () => {
    writePageFile(root, 'pricing', `
export async function generateMetadata() {
  return buildPageMetadata({ locale: 'en', title: 'x', description: 'y', path: '/pricing' });
}
export default function P() { return null; }
`);

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('NO_SEGMENT'))).toBe(true);
  });

  it('CHECK-03: MISSING_OG — imageSegment set but no opengraph-image.tsx', () => {
    writePageFile(root, 'pricing', GOOD_PAGE);
    // no OG file created

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('MISSING_OG'))).toBe(true);
  });

  it('CHECK-03: MISSING_OG suppressed with // seo-ignore og-image', () => {
    writePageFile(root, 'pricing', `// seo-ignore og-image\n${GOOD_PAGE}`);
    // no OG file

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('MISSING_OG'))).toBe(false);
  });

  it('CHECK-03: imageSegment "default" does not require opengraph-image.tsx', () => {
    writePageFile(root, 'pricing', GOOD_PAGE.replace("imageSegment: 'pricing'", "imageSegment: 'default'"));

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('MISSING_OG'))).toBe(false);
  });

  it('CHECK-04: BAD_OG_KEYS — opengraph-image.tsx using hero.* keys', () => {
    writePageFile(root, 'pricing', GOOD_PAGE);
    writeOgFile(root, 'pricing', `
import { getTranslations } from 'next-intl/server';
import { renderOgImage, OG_SIZE, OG_CONTENT_TYPE } from '@kb-labs/web-og';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export default async function OpengraphImage({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'pricing' });
  return renderOgImage({ title: t('hero.title'), description: t('hero.subtitle') });
}
`);

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('BAD_OG_KEYS'))).toBe(true);
  });

  it('CHECK-04: BAD_OG_KEYS suppressed with // seo-ignore og-keys', () => {
    writePageFile(root, 'pricing', `// seo-ignore og-keys\n${GOOD_PAGE}`);
    writeOgFile(root, 'pricing', `
import { getTranslations } from 'next-intl/server';
import { renderOgImage, OG_SIZE, OG_CONTENT_TYPE } from '@kb-labs/web-og';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export default async function OpengraphImage({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return renderOgImage({ title: t('hero.title'), description: t('hero.subtitle') });
}
`);

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('BAD_OG_KEYS'))).toBe(false);
  });

  it('CHECK-05: TITLE_LENGTH — title shorter than 15 chars', () => {
    const en = { pricing: { meta: { title: 'Pricing', description: 'Valid description that is longer than seventy characters, yes indeed it is.' } } };
    const ru = { pricing: { meta: { title: 'Цены', description: 'Валидное описание длиннее семидесяти символов, да это именно так и есть.' } } };
    writeFileSync(join(root, 'messages', 'en.json'), JSON.stringify(en));
    writeFileSync(join(root, 'messages', 'ru.json'), JSON.stringify(ru));
    writePageFile(root, 'pricing', GOOD_PAGE);
    writeOgFile(root, 'pricing', GOOD_OG);

    const { issues } = runDevkit(root);
    const hit = issues.find(i => i.message.includes('TITLE_LENGTH'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
  });

  it('CHECK-05: TITLE_LENGTH — title longer than 65 chars', () => {
    const longTitle = 'A'.repeat(70);
    const en = { pricing: { meta: { title: longTitle, description: 'Valid description that is longer than seventy characters, yes indeed it is.' } } };
    const ru = { pricing: { meta: { title: 'Цены и планы — KB Labs', description: 'Валидное описание длиннее семидесяти символов, да это именно так и есть.' } } };
    writeFileSync(join(root, 'messages', 'en.json'), JSON.stringify(en));
    writeFileSync(join(root, 'messages', 'ru.json'), JSON.stringify(ru));
    writePageFile(root, 'pricing', GOOD_PAGE);
    writeOgFile(root, 'pricing', GOOD_OG);

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('TITLE_LENGTH'))).toBe(true);
  });

  it('CHECK-06: TITLE_BRAND — title without "KB Labs" is a warning', () => {
    const en = { pricing: { meta: { title: 'Pricing and Plans Here', description: 'Valid description that is longer than seventy characters, yes indeed it is.' } } };
    const ru = { pricing: { meta: { title: 'Цены и планы — KB Labs', description: 'Валидное описание длиннее семидесяти символов, да это именно так и есть.' } } };
    writeFileSync(join(root, 'messages', 'en.json'), JSON.stringify(en));
    writeFileSync(join(root, 'messages', 'ru.json'), JSON.stringify(ru));
    writePageFile(root, 'pricing', GOOD_PAGE);
    writeOgFile(root, 'pricing', GOOD_OG);

    const { issues } = runDevkit(root);
    const hit = issues.find(i => i.message.includes('TITLE_BRAND'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('warning');
  });

  it('CHECK-06: TITLE_BRAND suppressed with // seo-ignore title-brand', () => {
    const en = { pricing: { meta: { title: 'Pricing and Plans Here', description: 'Valid description that is longer than seventy characters, yes indeed it is.' } } };
    const ru = { pricing: { meta: { title: 'Цены и планы — KB Labs', description: 'Валидное описание длиннее семидесяти символов, да это именно так и есть.' } } };
    writeFileSync(join(root, 'messages', 'en.json'), JSON.stringify(en));
    writeFileSync(join(root, 'messages', 'ru.json'), JSON.stringify(ru));
    writePageFile(root, 'pricing', `// seo-ignore title-brand\n${GOOD_PAGE}`);
    writeOgFile(root, 'pricing', GOOD_OG);

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('TITLE_BRAND'))).toBe(false);
  });

  it('CHECK-07: DESC_LENGTH — description shorter than 70 chars', () => {
    const en = { pricing: { meta: { title: 'Pricing and Plans — KB Labs', description: 'Too short.' } } };
    const ru = { pricing: { meta: { title: 'Цены и планы — KB Labs', description: 'Валидное описание длиннее семидесяти символов, да это именно так и есть.' } } };
    writeFileSync(join(root, 'messages', 'en.json'), JSON.stringify(en));
    writeFileSync(join(root, 'messages', 'ru.json'), JSON.stringify(ru));
    writePageFile(root, 'pricing', GOOD_PAGE);
    writeOgFile(root, 'pricing', GOOD_OG);

    const { issues } = runDevkit(root);
    const hit = issues.find(i => i.message.includes('DESC_LENGTH'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
  });

  it('CHECK-07: DESC_LENGTH — description longer than 165 chars', () => {
    const longDesc = 'A'.repeat(170);
    const en = { pricing: { meta: { title: 'Pricing and Plans — KB Labs', description: longDesc } } };
    const ru = { pricing: { meta: { title: 'Цены и планы — KB Labs', description: 'Валидное описание длиннее семидесяти символов, да это именно так и есть.' } } };
    writeFileSync(join(root, 'messages', 'en.json'), JSON.stringify(en));
    writeFileSync(join(root, 'messages', 'ru.json'), JSON.stringify(ru));
    writePageFile(root, 'pricing', GOOD_PAGE);
    writeOgFile(root, 'pricing', GOOD_OG);

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('DESC_LENGTH'))).toBe(true);
  });

  it('CHECK-08: NO_JSONLD — page without JSON-LD produces a warning', () => {
    writePageFile(root, 'pricing', GOOD_PAGE);
    writeOgFile(root, 'pricing', GOOD_OG);

    const { issues } = runDevkit(root);
    const hit = issues.find(i => i.message.includes('NO_JSONLD'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('warning');
  });

  it('CHECK-08: NO_JSONLD suppressed with // seo-ignore jsonld', () => {
    writePageFile(root, 'pricing', `// seo-ignore jsonld\n${GOOD_PAGE}`);
    writeOgFile(root, 'pricing', GOOD_OG);

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('NO_JSONLD'))).toBe(false);
  });

  it('CHECK-00: all passing page → zero issues', () => {
    const pageWithJsonLd = GOOD_PAGE + '\n// application/ld+json structured data present\n';
    writePageFile(root, 'pricing', `// seo-ignore jsonld\n${GOOD_PAGE}`);
    writeOgFile(root, 'pricing', GOOD_OG);

    // Use fixture with valid lengths (already set up in setup())
    const { issues } = runDevkit(root);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('CHECK-00: devkit mode exits with 0 even when errors exist', () => {
    writePageFile(root, 'pricing', 'export default function P() { return null; }');

    const result = spawnSync('node', [SCRIPT], {
      env: {
        ...process.env,
        KB_DEVKIT_MODE: '1',
        KB_DEVKIT_PACKAGE_NAME: '@kb-labs/web-site',
        KB_DEVKIT_PACKAGE_DIR: root,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { issues: Array<{ severity: string }> };
    expect(out.issues.some(i => i.severity === 'error')).toBe(true);
  });

  it('CHECK-00: dynamic routes ([slug]) are skipped', () => {
    // [slug] dir should be skipped entirely
    const slugDir = join(root, 'app', '[locale]', '[slug]');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, 'page.tsx'), 'export default function P() { return null; }');

    const { issues } = runDevkit(root);
    expect(issues.some(i => i.message.includes('[slug]'))).toBe(false);
  });
});
