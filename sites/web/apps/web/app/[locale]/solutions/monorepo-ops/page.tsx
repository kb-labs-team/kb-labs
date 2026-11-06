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
  MockupFrame,
  Section,
  Tabs,
} from '@kb-labs/web-site-ui';
import { buildPageMetadata } from '@/lib/page-metadata';

type Props = { params: Promise<{ locale: string }> };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'solutionMonorepoOps' });
  return buildPageMetadata({
    locale,
    title: t('meta.title'),
    description: t('meta.description'),
    path: '/solutions/monorepo-ops',
    imageSegment: 'solutions/monorepo-ops',
  });
}

// ── Content ───────────────────────────────────────────────────────────────────

// i18n-ignore
const BUILD_AFFECTED_OUTPUT = `$ kb-devkit run build --affected

  Detected 3 changed packages (git strategy)

  @kb-labs/core-types      ●  building   [1.4s]
  @kb-labs/core-platform   ●  building   [2.1s]
  @kb-labs/sdk             ●  building   [3.2s]
  @kb-labs/commit/core     ●  building   [0.9s]
  @kb-labs/commit    ●  building   [1.3s]
  @kb-labs/qa        ◌  cached     [0ms]
  @kb-labs/quality   ◌  cached     [0ms]
  @kb-labs/review    ◌  cached     [0ms]

  Done in 9.4s  ·  5 built  ·  113 from cache`;

// i18n-ignore
const BUILD_FULL_OUTPUT = `$ kb-devkit run build

  @kb-labs/core-types      ◌  cached   [0ms]
  @kb-labs/core-platform   ◌  cached   [0ms]
  @kb-labs/sdk             ◌  cached   [0ms]
  @kb-labs/agents/sdk      ◌  cached   [0ms]
  ... 114 more packages

  Done in 0.8s  ·  0 built  ·  118 from cache`;

// i18n-ignore
const STATS_OUTPUT = `$ kb-devkit stats

  KB Devkit — Workspace Stats

  Health Score   72/100  Grade C
  (98 healthy, 12 warning, 8 error of 118 total)

  By category
  go-binary       ████████████  7/7    Grade A
  ts-lib          ██████████░░  77/93  Grade B
  ts-app          ████████░░░░  14/18  Grade C

  Issues by check
  structure         3 errors  8 warnings  in 11 packages
  package_json      2 errors  4 warnings  in  6 packages
  eslint            1 error   2 warnings  in  3 packages

  Coverage (TS packages)
  ✓ ESLint config    94%  (104/111)
  ✓ TSConfig         98%  (109/111)
  ⚠ README.md        61%   (68/111)
  ⚠ engines field    72%   (80/111)
  ✓ exports field    91%  (101/111)`;

// i18n-ignore
// i18n-ignore
const CUSTOM_CHECKS_CONFIG = `# devkit.yaml
custom_checks:
  - name: license-header
    run: ./scripts/check-license.sh
    fix: ./scripts/fix-license.sh
    on: [check, gate]
    language: typescript

  - name: no-barrel-exports
    run: node scripts/check-barrels.js
    language: typescript`;

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function MonorepoOpsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'solutionMonorepoOps' });

  const buildCommands = t.raw('page.buildCommands') as Array<{ cmd: string; note: string }>;
  const healthCommands = t.raw('page.healthCommands') as Array<{ cmd: string; note: string }>;

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
                <Eyebrow className="mb-4">{t('page.heroEyebrow')}</Eyebrow>
                <h1 className="mb-5 text-4xl font-bold leading-tight tracking-tight text-kb-text sm:text-5xl lg:text-6xl">
                  {t('page.heroTitle')}{' '}
                  <GradientText>{t('page.heroTitleHighlight')}</GradientText>
                </h1>
                <p className="mx-auto mb-8 max-w-xl text-lg leading-relaxed text-muted/70">
                  {t('page.heroDescription')}
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  <Button variant="primary" size="lg" href="https://docs.kblabs.ru/services/kb-devkit" target="_blank" rel="noopener noreferrer">
                    {t('page.docsBtn')}
                  </Button>
                  <Button variant="secondary" size="lg" href={`/${locale}/install`}>
                    {t('page.installBtn')}
                  </Button>
                </div>
              </div>
            </AnimateOnScroll>
          </Container>
        </section>

        {/* ── Build ── */}
        <Section className="border-b border-line">
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
              <AnimateOnScroll>
                <Eyebrow className="mb-3">{t('page.buildEyebrow')}</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('page.buildTitle')}
                </h2>
                <p className="mb-6 text-base leading-relaxed text-muted/70">
                  {t('page.buildLead')}
                </p>
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                  {buildCommands.map((c, i, arr) => (
                    <div key={c.cmd} className={`flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:items-baseline sm:gap-4 ${i < arr.length - 1 ? 'border-b border-line' : ''}`}>
                      <code className="flex-shrink-0 font-mono text-[0.8rem] text-kb-text/85 sm:w-56">{c.cmd}</code>
                      <span className="text-sm leading-relaxed text-muted/50">{c.note}</span>
                    </div>
                  ))}
                </div>
              </AnimateOnScroll>

              <AnimateOnScroll delay={80}>
                <Tabs
                  variant="card"
                  contentClassName="max-h-[320px] overflow-auto"
                  items={[
                    {
                      id: 'affected',
                      label: t('page.tabAffected'),
                      content: <CodeBlock code={BUILD_AFFECTED_OUTPUT} language="bash" bare />,
                    },
                    {
                      id: 'cached',
                      label: t('page.tabCached'),
                      content: <CodeBlock code={BUILD_FULL_OUTPUT} language="bash" bare />,
                    },
                  ]}
                />
              </AnimateOnScroll>
            </div>
          </Container>
        </Section>

        {/* ── Health ── */}
        <Section className="border-b border-line bg-surface/40">
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
              <AnimateOnScroll className="lg:order-2">
                <Eyebrow className="mb-3">{t('page.healthEyebrow')}</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('page.healthTitle')}
                </h2>
                <p className="mb-4 text-base leading-relaxed text-muted/70">
                  {t('page.healthLead1')}
                </p>
                <p className="mb-6 text-base leading-relaxed text-muted/70">
                  {/* i18n-ignore: code identifiers inline */}
                  {t('page.healthLead2', { code: 'custom_checks', result: '{"issues": [...]}' })}
                </p>
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                  {healthCommands.map((c, i, arr) => (
                    <div key={c.cmd} className={`flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:items-baseline sm:gap-4 ${i < arr.length - 1 ? 'border-b border-line' : ''}`}>
                      <code className="flex-shrink-0 font-mono text-[0.8rem] text-kb-text/85 sm:w-36">{c.cmd}</code>
                      <span className="text-sm leading-relaxed text-muted/50">{c.note}</span>
                    </div>
                  ))}
                </div>
              </AnimateOnScroll>

              <AnimateOnScroll delay={80} className="lg:order-1">
                <Tabs
                  variant="card"
                  contentClassName="max-h-[380px] overflow-auto"
                  items={[
                    {
                      id: 'stats',
                      label: 'kb-devkit stats', // i18n-ignore: command label
                      content: <CodeBlock code={STATS_OUTPUT} language="bash" bare />,
                    },
                    {
                      id: 'custom',
                      label: 'custom_checks', // i18n-ignore: config key label
                      content: <CodeBlock code={CUSTOM_CHECKS_CONFIG} language="yaml" bare />,
                    },
                  ]}
                />
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
                  <Eyebrow className="mb-4">{t('page.ctaEyebrow')}</Eyebrow>
                  <h2 className="mb-4 text-[clamp(1.8rem,3.5vw,2.8rem)] font-bold leading-tight tracking-tight text-kb-text">
                    {t('page.ctaTitle')}
                  </h2>
                  <p className="mx-auto mb-8 max-w-sm text-base text-muted/75 dark:text-muted/60">
                    {t('page.ctaNote')}
                  </p>
                  <div className="flex flex-wrap justify-center gap-3">
                    <Button variant="primary" size="lg" href="https://docs.kblabs.ru/services/kb-devkit" target="_blank" rel="noopener noreferrer">
                      {t('page.docsBtn')}
                    </Button>
                    <Button variant="secondary" size="lg" href={`/${locale}/install`}>
                      {t('page.installBtn')}
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
