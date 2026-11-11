import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import {
  AnimateOnScroll,
  BorderBeam,
  Button,
  CodeBlock,
  Container,
  CopyButton,
  DotPattern,
  Eyebrow,
  GradientText,
  Section,
} from '@kb-labs/web-site-ui';
import { buildPageMetadata } from '@/lib/page-metadata';
import { ExternalLink } from 'lucide-react';

type Props = { params: Promise<{ locale: string }> };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'solutionReleaseAutomation' });
  return buildPageMetadata({
    locale,
    title: t('meta.title'),
    description: t('meta.description'),
    path: '/solutions/release-automation',
    imageSegment: 'solutions/release-automation',
  });
}

// ── Content ───────────────────────────────────────────────────────────────────

// What you actually see during kb release run:
// 1. Plan table (sideBox before confirmation)
// 2. Spinner with [X.Xs] progress messages
// 3. Result sideBox
// i18n-ignore
const PLAN_OUTPUT = `$ kb release run

  ╭─ Release Plan ───────────────────────────────────────────────╮
  │  12 package(s) · strategy: lockstep                          │
  │                                                              │
  │  ·  @kb-labs/core-types              1.4.1  →  1.4.2         │
  │  ·  @kb-labs/core-platform           1.4.1  →  1.4.2         │
  │  ·  @kb-labs/sdk                     1.4.1  →  1.4.2         │
  │  ·  @kb-labs/release/core   1.4.1  →  1.4.2          │
  │  ·  ... 8 more packages                                      │
  ╰──────────────────────────────────────────────────────────────╯

Proceed with release? [y/N] y

  ~  [4.1s] Running 3 pre-release check(s)...
  ~  [18.2s] Building 12 package(s)...
  ~  [22.4s] Verifying package artifacts...
  ~  [23.0s] Updating package versions...
  ~  [25.1s] Generating changelog...
  ~  [27.3s] Publishing packages...
  ~  [44.8s] Committing and tagging release...
  ✓  Release completed`;

// corporate-ai template output (real format from template source)
// i18n-ignore
const CHANGELOG_OUTPUT = `## [1.4.2] - 2026-05-24

> **@kb-labs/release/core** 1.4.1 → 1.4.2 (patch)

### Fixes
- Atomic build now correctly handles symlinks inside dist/
- Checkpoint detection skips stale entries older than 24h

### Internal
- Pipeline timing reported per-step in \`kb release report show\``;

// i18n-ignore
const RELEASE_CONFIG = `{
  "release": {
    "changelog": {
      "template": "corporate-ai",
      "locale": "en"
    },
    "flows": {
      "platform": {
        "packages": {
          "include": ["@kb-labs/core-*", "@kb-labs/plugin-*", "@kb-labs/adapter-*"]
        },
        "versioningStrategy": "lockstep",
        "checks": ["pnpm type-check", "pnpm test"]
      },
      "sdk": {
        "packages": {
          "include": ["@kb-labs/sdk", "@kb-labs/agents/sdk"]
        },
        "versioningStrategy": "independent",
        "checks": ["pnpm lint", "pnpm type-check", "pnpm test"]
      }
    }
  }
}`;

// i18n-ignore
const CHECKS_CONFIG = `"checks": [
  {
    "id": "type-check",
    "command": "pnpm type-check",
    "runIn": "repoRoot"
  },
  {
    "id": "test",
    "command": "pnpm test",
    "runIn": "perPackage",
    "timeoutMs": 60000
  },
  {
    "id": "size-limit",
    "command": "pnpm size-limit --json",
    "parser": "json",
    "runIn": "scopePath",
    "optional": true
  }
]`;

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function ReleaseAutomationPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'solutionReleaseAutomation' });

  const pipelineStages = t.raw('pipeline.stages') as Array<{ stage: string; label: string; detail: string }>;
  const designDecisions = t.raw('designDecisions.items') as Array<{ title: string; detail: string }>;
  const flowRuns = t.raw('flows.runs') as Array<{ cmd: string; packages: string; strategy: string; note: string }>;
  const configItems = t.raw('config.items') as string[];

  return (
    <>
      <SiteHeader />
      <main>

        {/* ── Hero ── */}
        <section className="relative overflow-hidden border-b border-line py-10 pb-8 sm:py-20 sm:pb-16">
          <DotPattern className="absolute inset-0 z-0 opacity-40" />
          <Container className="relative z-10">
            <AnimateOnScroll>
              <div className="mx-auto max-w-3xl text-center">
                <Eyebrow className="mb-4">{t('hero.eyebrow')}</Eyebrow>
                <h1 className="mb-5 text-4xl font-bold leading-tight tracking-tight text-kb-text sm:text-5xl lg:text-6xl">
                  {t('hero.titlePrefix')}{' '}
                  <GradientText>{t('hero.titleHighlight')}</GradientText>
                  {' '}{t('hero.titleConnector')}<br />
                  {t('hero.titleSuffix')}
                </h1>
                <p className="mx-auto mb-8 max-w-xl text-lg leading-relaxed text-muted/70">
                  {t('hero.description')}
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  <Button variant="primary" size="lg" href="https://docs.kblabs.ru/use-cases/scenario-release-notes" target="_blank" rel="noopener noreferrer">
                    {t('hero.docsBtn')}
                    <ExternalLink className="ml-2 size-4" />
                  </Button>
                  <Button variant="secondary" size="lg" href={`/${locale}/install`}>
                    {t('hero.installBtn')}
                  </Button>
                </div>
              </div>
            </AnimateOnScroll>
          </Container>
        </section>

        {/* ── What you actually see ── */}
        <Section className="border-b border-line">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto mb-10 max-w-xl text-center">
                <Eyebrow className="mb-3">{t('howItLooks.eyebrow')}</Eyebrow>
                <h2 className="text-3xl font-bold tracking-tight text-kb-text">
                  {t('howItLooks.title')}
                </h2>
              </div>
            </AnimateOnScroll>

            <div className="grid items-start gap-6 lg:grid-cols-2">
              <AnimateOnScroll delay={0}>
                {/* i18n-ignore: terminal command label */}
                <p className="mb-2 h-5 text-sm font-semibold uppercase tracking-widest text-muted/55 dark:text-muted/40">
                  kb release run
                </p>
                <div className="overflow-hidden rounded-2xl border border-line bg-[#0f1115]">
                  <div className="overflow-x-auto p-5">
                    <pre className="whitespace-pre font-mono text-[0.78rem] leading-[1.85] text-slate-300">{PLAN_OUTPUT}</pre>
                  </div>
                </div>
              </AnimateOnScroll>

              <AnimateOnScroll delay={80}>
                {/* i18n-ignore: filename label */}
                <p className="mb-2 h-5 text-sm font-semibold uppercase tracking-widest text-muted/55 dark:text-muted/40">
                  CHANGELOG.md · corporate-ai
                </p>
                <div className="overflow-hidden rounded-2xl border border-line bg-surface">
                  <div className="max-h-[260px] overflow-y-auto">
                    <CodeBlock code={CHANGELOG_OUTPUT} language="markdown" />
                  </div>
                </div>
                <p className="mt-2.5 text-sm leading-relaxed text-muted/55 dark:text-muted/40">
                  {t('changelogNote', { templates: 'corporate-ai, corporate, technical, compact' })}
                </p>
              </AnimateOnScroll>
            </div>
          </Container>
        </Section>

        {/* ── Pipeline ── */}
        <Section className="border-b border-line bg-surface/40">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto mb-10 max-w-xl text-center">
                <Eyebrow className="mb-3">{t('pipeline.eyebrow')}</Eyebrow>
                <h2 className="text-3xl font-bold tracking-tight text-kb-text">
                  {t('pipeline.title')}
                </h2>
                <p className="mt-3 text-sm text-muted/50">
                  {t('pipeline.subtitle')}
                </p>
              </div>
            </AnimateOnScroll>

            <AnimateOnScroll delay={60}>
              <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                {pipelineStages.map((s, i) => (
                  <div
                    key={s.stage}
                    className={`flex flex-col gap-1.5 px-6 py-4 sm:flex-row sm:items-baseline sm:gap-6 ${i < pipelineStages.length - 1 ? 'border-b border-line' : ''}`}
                  >
                    <div className="flex flex-shrink-0 items-center gap-3 sm:w-40">
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-bold text-accent">
                        {i + 1}
                      </span>
                      <span className="text-sm font-semibold text-kb-text">{s.label}</span>
                    </div>
                    <span className="text-sm leading-relaxed text-muted/60">{s.detail}</span>
                  </div>
                ))}
              </div>
            </AnimateOnScroll>
          </Container>
        </Section>

        {/* ── Design decisions ── */}
        <Section className="border-b border-line">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto mb-12 max-w-xl text-center">
                <Eyebrow className="mb-3">{t('designDecisions.eyebrow')}</Eyebrow>
                <h2 className="text-3xl font-bold tracking-tight text-kb-text">
                  {t('designDecisions.title')}
                </h2>
              </div>
            </AnimateOnScroll>

            <div className="grid gap-6 lg:grid-cols-3">
              {designDecisions.map((d, i) => (
                <AnimateOnScroll key={d.title} delay={i * 80}>
                  <div className="flex h-full flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm">
                    <h3 className="mb-3 text-base font-semibold text-kb-text">{d.title}</h3>
                    <p className="mt-auto text-sm leading-relaxed text-muted/60">{d.detail}</p>
                  </div>
                </AnimateOnScroll>
              ))}
            </div>
          </Container>
        </Section>

        {/* ── Flows ── */}
        <Section className="border-b border-line">
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
              <AnimateOnScroll>
                <Eyebrow className="mb-3">{t('flows.eyebrow')}</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('flows.title')}
                </h2>
                <p className="mb-4 text-base leading-relaxed text-muted/70">
                  {t('flows.lead1')}
                </p>
                <p className="text-base leading-relaxed text-muted/70">
                  {t('flows.lead2')}
                </p>
              </AnimateOnScroll>

              <AnimateOnScroll delay={80}>
                <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                  {flowRuns.map((f) => (
                    <div key={f.cmd} className="px-5 py-4">
                      <code className="mb-3 block font-mono text-[0.82rem] font-semibold text-kb-text/90">
                        {f.cmd}
                      </code>
                      <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 text-sm">
                        <span className="text-muted/55 dark:text-muted/40">{t('flows.packagesLabel')}</span>
                        <code className="font-mono text-muted/70">{f.packages}</code>
                        <span className="text-muted/55 dark:text-muted/40">{t('flows.strategyLabel')}</span>
                        <span className="text-muted/70">{f.strategy}</span>
                      </div>
                      <p className="mt-3 border-t border-line pt-2.5 text-sm text-muted/50">{f.note}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-2.5 text-sm leading-relaxed text-muted/55 dark:text-muted/40">
                  {t('flows.configNote', { code: 'packages' })}
                </p>
              </AnimateOnScroll>
            </div>
          </Container>
        </Section>

        {/* ── Checks ── */}
        <Section className="border-b border-line bg-surface/40">
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
              <AnimateOnScroll delay={80}>
                {/* i18n-ignore: section label */}
                <p className="mb-2 h-5 text-sm font-semibold uppercase tracking-widest text-muted/55 dark:text-muted/40">
                  checks config
                </p>
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                  <div className="max-h-72 overflow-y-auto">
                    <CodeBlock code={CHECKS_CONFIG} language="json" />
                  </div>
                </div>
              </AnimateOnScroll>

              <AnimateOnScroll>
                <Eyebrow className="mb-3">{t('checks.eyebrow')}</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('checks.title')}
                </h2>
                <p className="mb-6 text-base leading-relaxed text-muted/70">
                  {t('checks.lead')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {/* i18n-ignore: code configuration tags */}
                  {['runIn: repoRoot', 'runIn: perPackage', 'runIn: scopePath', 'parser: json', 'optional', 'timeoutMs'].map((tag) => (
                    <code key={tag} className="rounded-lg border border-line bg-bg px-3 py-1.5 font-mono text-[0.78rem] text-muted/70">
                      {tag}
                    </code>
                  ))}
                </div>
              </AnimateOnScroll>
            </div>
          </Container>
        </Section>

        {/* ── Config ── */}
        <Section className="border-b border-line bg-surface/40">
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
              <AnimateOnScroll>
                <Eyebrow className="mb-3">{t('config.eyebrow')}</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('config.title')}
                </h2>
                <p className="mb-5 text-base leading-relaxed text-muted/70">
                  {/* i18n-ignore: filenames inline */}
                  {t('config.lead', { configFile: '.kb/kb.config.json', releaseConfig: 'release.config.js' })}
                </p>
                <ul className="space-y-2 text-sm leading-relaxed text-muted/60">
                  {configItems.map((item) => (
                    <li key={item} className="flex items-baseline gap-2">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-accent/60" />
                      {item}
                    </li>
                  ))}
                </ul>
              </AnimateOnScroll>

              <AnimateOnScroll delay={100}>
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                  <div className="max-h-72 overflow-y-auto">
                    <CodeBlock code={RELEASE_CONFIG} language="json" />
                  </div>
                </div>
              </AnimateOnScroll>
            </div>
          </Container>
        </Section>

        {/* ── CTA ── */}
        <Section className="bg-bg">
          <Container>
            <AnimateOnScroll>
              <div className="relative overflow-hidden rounded-3xl border border-line bg-bg px-5 py-10 sm:px-8 sm:py-16 text-center">
                <BorderBeam />
                <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[360px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/[0.06] blur-[90px]" />
                <div className="relative z-10">
                  <Eyebrow className="mb-4">{t('cta.eyebrow')}</Eyebrow>
                  <h2 className="mb-4 text-[clamp(1.8rem,3.5vw,2.8rem)] font-bold leading-tight tracking-tight text-kb-text">
                    {t('cta.title')}
                  </h2>
                  <div className="mx-auto mb-8 flex max-w-md items-center justify-between gap-3 rounded-xl border border-line bg-surface/60 px-4 py-3">
                    {/* i18n-ignore: terminal command */}
                    <code className="font-mono text-[0.85rem] text-kb-text">
                      kb marketplace install @kb-labs/release
                    </code>
                    <CopyButton code="kb marketplace install @kb-labs/release" className="shrink-0" />
                  </div>
                  <div className="flex flex-wrap justify-center gap-3">
                    <Button variant="primary" size="lg" href="https://docs.kblabs.ru/use-cases/scenario-release-notes" target="_blank" rel="noopener noreferrer">
                      {t('cta.docsBtn')}
                    </Button>
                    <Button variant="secondary" size="lg" href={`/${locale}/install`}>
                      {t('cta.installBtn')}
                    </Button>
                  </div>
                </div>
              </div>
            </AnimateOnScroll>
          </Container>
        </Section>

      </main>
      <SiteFooter />
    </>
  );
}
