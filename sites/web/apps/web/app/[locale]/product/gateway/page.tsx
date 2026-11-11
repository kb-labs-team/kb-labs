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
  DotPattern,
  Eyebrow,
  GatewayAdapterSwapDiagram,
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
  const t = await getTranslations({ locale, namespace: 'gateway' });
  return buildPageMetadata({
    locale,
    title: t('meta.title'),
    description: t('meta.description'),
    path: '/product/gateway',
    imageSegment: 'product/gateway',
  });
}

// ── Code examples ────────────────────────────────────────────────────────────

const PLATFORM_API_CODE = `\
# Cart service pushes an event — no Redis SDK, no Kafka client
POST /platform/v1/eventBus/publish
Authorization: Bearer <token>
Content-Type: application/json

{
  "args": ["order.created", {
    "orderId": "ord-9f2a",
    "total":   149.90
  }]
}

# 200 OK
{ "ok": true, "result": null, "durationMs": 3 }`;

const LLM_CODE = `\
# OpenAI-compatible — "model" is a tier, not a model name
POST /llm/v1/chat/completions
Authorization: Bearer <token>
Content-Type: application/json

{
  "model":    "medium",
  "messages": [{ "role": "user", "content": "Classify this ticket" }],
  "stream":   true
}

# Swap Anthropic → OpenAI in kb.config.json — this request stays the same`;

const TELEMETRY_CODE = `\
# Any service sends events — free-form payload, dot-notation type
POST /telemetry/v1/ingest
Authorization: Bearer <token>
Content-Type: application/json

{
  "events": [{
    "source":  "cart-service",
    "type":    "order.completed",
    "payload": { "orderId": "ord-9f2a", "total": 149.90 },
    "tags":    { "env": "prod", "region": "eu" }
  }]
}

# Up to 500 events per batch. Goes to IAnalytics — SQLite, DuckDB, or file.`;

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function GatewayPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'gateway' });

  return (
    <>
      <SiteHeader />
      <main>

        {/* ── Hero ── */}
        <section className="relative overflow-hidden py-20 pb-12">
          <DotPattern className="absolute inset-0 z-0 opacity-40" />
          <Container className="relative z-10">
            <div className="mx-auto max-w-2xl text-center">
              {/* i18n-ignore: brand + port label */}
              <Eyebrow className="mb-4">Infrastructure · :4000</Eyebrow>
              <h1 className="mb-5 text-4xl font-bold leading-tight tracking-tight text-kb-text sm:text-5xl">
                {t('heroTitle')}{' '}
                <GradientText>{t('heroTitleHighlight')}</GradientText>
              </h1>
              <p className="mb-8 text-lg leading-relaxed text-muted/70">
                {t('heroDescription')}
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <Button asChild size="lg">
                  <a href="https://docs.kblabs.ru/gateway" target="_blank" rel="noopener noreferrer">
                    {t('heroDocsBtn')}
                    <ExternalLink className="ml-2 size-4" />
                  </a>
                </Button>
                <Button asChild variant="outline" size="lg">
                  <a href={`/${locale}/install`}>{t('heroInstallBtn')}</a>
                </Button>
              </div>
            </div>
            <div className="mx-auto mt-14 max-w-lg">
              <GatewayAdapterSwapDiagram caption={t('adapterDiagramCaption')} />
            </div>
          </Container>
        </section>

        {/* ── Platform API ── */}
        <Section>
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
              <AnimateOnScroll>
                {/* i18n-ignore: brand name */}
                <Eyebrow className="mb-3">Platform API</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('platformTitle')}
                </h2>
                <p className="mb-6 text-base leading-relaxed text-muted/70">
                  {t('platformLead')}
                </p>
                <Button asChild variant="outline" size="sm">
                  <a href="https://docs.kblabs.ru/gateway" target="_blank" rel="noopener noreferrer">
                    {t('platformDocsBtn')}
                    <ExternalLink className="ml-2 size-3.5" />
                  </a>
                </Button>
              </AnimateOnScroll>
              <AnimateOnScroll delay={100}>
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                  <CodeBlock
                    code={PLATFORM_API_CODE}
                    language="bash"
                  />
                </div>
              </AnimateOnScroll>
            </div>
          </Container>
        </Section>

        {/* ── AI Gateway ── */}
        <Section className="bg-surface/50">
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
              <AnimateOnScroll>
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                  <CodeBlock
                    code={LLM_CODE}
                    language="bash"
                  />
                </div>
              </AnimateOnScroll>
              <AnimateOnScroll delay={100}>
                {/* i18n-ignore: brand name */}
                <Eyebrow className="mb-3">AI Gateway</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('aiTitle')}
                </h2>
                <p className="mb-6 text-base leading-relaxed text-muted/70">
                  {t('aiLead')}
                </p>
                <Button asChild variant="outline" size="sm">
                  <a href="https://docs.kblabs.ru/gateway" target="_blank" rel="noopener noreferrer">
                    {t('aiDocsBtn')}
                    <ExternalLink className="ml-2 size-3.5" />
                  </a>
                </Button>
              </AnimateOnScroll>
            </div>
          </Container>
        </Section>

        {/* ── Telemetry ── */}
        <Section>
          <Container>
            <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
              <AnimateOnScroll>
                {/* i18n-ignore: brand name */}
                <Eyebrow className="mb-3">Telemetry</Eyebrow>
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-kb-text">
                  {t('telemetryTitle')}
                </h2>
                <p className="mb-6 text-base leading-relaxed text-muted/70">
                  {t('telemetryLead')}
                </p>
                <Button asChild variant="outline" size="sm">
                  <a href="https://docs.kblabs.ru/gateway" target="_blank" rel="noopener noreferrer">
                    {t('telemetryDocsBtn')}
                    <ExternalLink className="ml-2 size-3.5" />
                  </a>
                </Button>
              </AnimateOnScroll>
              <AnimateOnScroll delay={100}>
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                  <CodeBlock
                    code={TELEMETRY_CODE}
                    language="bash"
                  />
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
                  <Eyebrow className="mb-4">{t('ctaEyebrow')}</Eyebrow>
                  <h2 className="mb-4 text-[clamp(1.8rem,3.5vw,2.8rem)] font-bold leading-tight tracking-tight text-kb-text">
                    {t('ctaTitle')}
                  </h2>
                  <p className="mx-auto mb-8 max-w-[44ch] text-[1.05rem] leading-[1.7] text-muted">
                    {t('ctaDescription')}
                  </p>
                  <div className="flex flex-wrap justify-center gap-3">
                    <Button variant="primary" size="lg" href={`/${locale}/install`}>
                      {t('ctaInstallBtn')}
                    </Button>
                    <Button variant="secondary" size="lg" href="https://docs.kblabs.ru/gateway" target="_blank" rel="noopener noreferrer">
                      {t('ctaDocsBtn')}
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
