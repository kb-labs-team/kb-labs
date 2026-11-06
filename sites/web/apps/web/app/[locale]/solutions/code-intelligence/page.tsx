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
  LabelValueTable,
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
  const t = await getTranslations({ locale, namespace: 'solutionCodeIntelligence' });
  return buildPageMetadata({
    locale,
    title: t('meta.title'),
    description: t('meta.description'),
    path: '/solutions/code-intelligence',
    imageSegment: 'solutions/code-intelligence',
  });
}

// ── Content ───────────────────────────────────────────────────────────────────

// i18n-ignore
const INDEX_OUTPUT = `$ kb mind index update

  ✓  Index updated in 22s (incremental)

  Files      discovered: 1 840 · processed: 68 · skipped: 1 772
  Chunks     stored: 9 440 · updated: 480 · rate: 7.06/file
  Cleanup    deleted files: 3 · deleted chunks: 22`;

// i18n-ignore
const FOUND_OUTPUT = `$ kb mind search --text "как работает pipeline релиза" --agent // i18n-ignore

{
  "chunks": [
    {
      "path": "plugins/release/src/core/pipeline.ts",
      "span": { "startLine": 1, "endLine": 12 },
      "score": 0.94,
      "text": "Flow: plan → snapshot → checks → build → verify..."
    },
    {
      "path": "plugins/release/src/cli/cli/commands/run.ts",
      "span": { "startLine": 180, "endLine": 210 },
      "score": 0.87,
      "text": "const result = await runReleasePipeline({..."
    }
  ],
  "contextText": "Release pipeline состоит из 8 последовательных шагов...", // i18n-ignore
  "meta": { "schemaVersion": "agent-response-v1", "timingMs": 14200 }
}`;

// i18n-ignore
const LOW_CONF_OUTPUT = `$ kb mind search --text "конфигурация redis кластера" --agent // i18n-ignore

{
  "quality": {
    "confidence": 0.28,
    "completeness": "minimal"
  },
  "candidates": [ ... ],
  "warnings": [{
    "code": "LOW_CONFIDENCE",
    "message": "Answer confidence is low (28%). Some claims may not be fully supported by sources."
  }],
  "meta": { "schemaVersion": "agent-response-v1" }
}`;

// i18n-ignore
const NOT_FOUND_OUTPUT = `$ kb mind search --text "как работает GraphQL федерация" --agent // i18n-ignore

{
  "quality": {
    "confidence": 0,
    "coverage": 0,
    "completeness": "minimal"
  },
  "candidates": [],
  "answer": "В индексированной кодовой базе не найдено релевантной информации.", // i18n-ignore
  "meta": { "schemaVersion": "agent-response-v1", "timingMs": 180 }
}`;

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function CodeIntelligencePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'solutionCodeIntelligence' });

  const indexTable = t.raw('page.indexTable') as Array<{ label: string; value: string }>;
  const commands = t.raw('page.commands') as Array<{ cmd: string; note: string }>;
  const agentTable = t.raw('page.agentTable') as Array<{ label: string; value: string }>;

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
                  <Button variant="primary" size="lg" href="https://docs.kblabs.ru/use-cases/showcase-mind" target="_blank" rel="noopener noreferrer">
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

        {/* ── Index ── */}
        <Section className="border-b border-line">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto mb-10 max-w-xl text-center">
                <Eyebrow className="mb-3">{t('page.indexEyebrow')}</Eyebrow>
                <h2 className="text-3xl font-bold tracking-tight text-kb-text">
                  {t('page.indexTitle')}
                </h2>
              </div>
            </AnimateOnScroll>

            <div className="grid items-start gap-8 lg:grid-cols-2">
              <AnimateOnScroll delay={0}>
                <MockupFrame type="terminal">
                  <pre className="whitespace-pre p-5 font-mono text-[0.78rem] leading-[1.85] text-slate-300">{INDEX_OUTPUT}</pre>
                </MockupFrame>
              </AnimateOnScroll>

              <AnimateOnScroll delay={80}>
                <LabelValueTable items={indexTable} valueClassName="text-muted/80 dark:text-muted/70" />
              </AnimateOnScroll>
            </div>
          </Container>
        </Section>

        {/* ── Honest answers ── */}
        <Section className="border-b border-line bg-surface/40">
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
              <AnimateOnScroll>
                <Eyebrow className="mb-3">{t('page.verifyEyebrow')}</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('page.verifyTitle')}
                </h2>
                <p className="mb-4 text-base leading-relaxed text-muted/70">
                  {t('page.verifyLead1')}
                </p>
                <p className="text-base leading-relaxed text-muted/70">
                  {t('page.verifyLead2')}
                </p>
              </AnimateOnScroll>

              <AnimateOnScroll delay={80}>
                <Tabs
                  variant="card"
                  contentClassName="max-h-[360px] overflow-auto"
                  items={[
                    {
                      id: 'found',
                      label: t('page.tabFound'),
                      content: <CodeBlock code={FOUND_OUTPUT} language="json" bare />,
                    },
                    {
                      id: 'low_conf',
                      label: t('page.tabLowConf'),
                      content: <CodeBlock code={LOW_CONF_OUTPUT} language="json" bare />,
                    },
                    {
                      id: 'not_found',
                      label: t('page.tabNotFound'),
                      content: <CodeBlock code={NOT_FOUND_OUTPUT} language="json" bare />,
                    },
                  ]}
                />
              </AnimateOnScroll>
            </div>
          </Container>
        </Section>

        {/* ── Commands ── */}
        <Section className="border-b border-line">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto mb-10 max-w-xl text-center">
                <Eyebrow className="mb-3">{t('page.commandsEyebrow')}</Eyebrow>
                <h2 className="text-3xl font-bold tracking-tight text-kb-text">
                  {t('page.commandsTitle')}
                </h2>
              </div>
            </AnimateOnScroll>

            <AnimateOnScroll delay={60}>
              <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                {commands.map((c, i) => (
                  <div
                    key={c.cmd}
                    className={`flex flex-col gap-1.5 px-6 py-4 sm:flex-row sm:items-baseline sm:gap-6 ${i < commands.length - 1 ? 'border-b border-line' : ''}`}
                  >
                    <code className="flex-shrink-0 font-mono text-[0.78rem] text-kb-text/85 sm:w-72">{c.cmd}</code>
                    <span className="text-sm leading-relaxed text-muted/50">{c.note}</span>
                  </div>
                ))}
              </div>
            </AnimateOnScroll>
          </Container>
        </Section>

        {/* ── Agent-first ── */}
        <Section className="border-b border-line bg-surface/40">
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
              <AnimateOnScroll>
                <Eyebrow className="mb-3">{t('page.agentEyebrow')}</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('page.agentTitle')}
                </h2>
                <p className="mb-4 text-base leading-relaxed text-muted/70">
                  {t('page.agentLead1')}
                </p>
                <p className="text-base leading-relaxed text-muted/70">
                  {t('page.agentLead2')}
                </p>
              </AnimateOnScroll>

              <AnimateOnScroll delay={80}>
                <LabelValueTable items={agentTable} valueClassName="text-muted/80 dark:text-muted/70" />
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
                  <div className="mx-auto mb-8 flex max-w-md items-center justify-between gap-3 rounded-xl border border-line bg-surface/60 px-4 py-3">
                    {/* i18n-ignore: terminal command */}
                    <code className="font-mono text-[0.85rem] text-kb-text">kb marketplace install @kb-labs/mind</code>
                    <CopyButton code="kb marketplace install @kb-labs/mind" className="shrink-0" />
                  </div>
                  <div className="flex flex-wrap justify-center gap-3">
                    <Button variant="primary" size="lg" href="https://docs.kblabs.ru/use-cases/showcase-mind" target="_blank" rel="noopener noreferrer">
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
