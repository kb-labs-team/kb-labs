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
  GradientText,
  PluginLifecycleDiagram,
  PluginSurfaceDiagram,
  Section,
  SectionHeader,
  StatCard,
} from '@kb-labs/web-site-ui';
import { buildPageMetadata } from '@/lib/page-metadata';
import { ExternalLink } from 'lucide-react';

type Props = { params: Promise<{ locale: string }> };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'plugins' });
  return buildPageMetadata({
    locale,
    title: t('meta.title'),
    description: t('meta.description'),
    path: '/product/plugins',
    imageSegment: 'product/plugins',
  });
}

const MANIFEST_CODE = `\
import { combinePermissions, kbPlatformPreset } from '@kb-labs/sdk';

export default {
  schema:      'kb.plugin/3',
  id:          '@kb-labs/review',
  version:     '2.94.0',
  permissions: combinePermissions()
    .with(kbPlatformPreset)
    .allow('git.read')     // can read git history
    .allow('llm.call')     // can call LLM
    .deny('fs.write')      // no filesystem writes
    .deny('shell.exec')    // no shell access
    .build(),
  cli: {
    commands: [
      { id: 'review',    handler: './commands/run.js#default' },
      { id: 'review:ci', handler: './commands/ci.js#default'  },
    ],
  },
} as const;`;

const SCAFFOLD_CODE = `\
# 1. scaffold
kb scaffold run plugin my-plugin

# 2. build
pnpm build

# 3. publish to KB Labs Registry
kb marketplace publish

# --- anyone can now install ---
kb marketplace install @you/my-plugin

# or share privately
kb marketplace share --with user123
kb marketplace share --link`;

// Real snippet from plugins/clickup/src/commands/task-create.ts
const HANDLER_CODE = `\
import { defineCommand, type CLIInput, type PluginContextV3 } from '@kb-labs/sdk';
import { requireApiKey, createTask } from '@kb-labs/clickup/core';

export default defineCommand({
  id: 'clickup:task.create',

  handler: {
    // intent() — declare what the plugin will do before it does it
    async intent(_ctx, input: CLIInput<TaskCreateFlags>) {
      const { list, name } = input.flags;
      return {
        summary: \`Create task "\${name}" in list \${list}\`,
        operations: [{ type: 'create', resource: 'task' }],
      };
    },

    async execute(ctx: PluginContextV3, input: CLIInput<TaskCreateFlags>) {
      const { list, name, desc, status, json } = input.flags;

      // business logic — the only thing the plugin author writes
      const task = await createTask(requireApiKey(), list, {
        name,
        markdown_content: desc,
        status,
      });

      // ctx.ui — same code, different surface: CLI, REST, Studio
      if (json) {
        ctx.ui.json({ id: task.id, name: task.name, url: task.url });
      } else {
        ctx.ui.success('Task created', {
          sections: [{ items: [\`id: \${task.id}\`, \`url: \${task.url}\`] }],
        });
      }

      return { exitCode: 0, result: task };
    },
  },
});`;


export default async function PluginsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'plugins' });

  const plugStats = t.raw('stats') as Array<{ value: string; label: string }>;
  const plugEcoSteps = t.raw('ecoSteps') as Array<{ step: string; title: string; desc: string }>;

  return (
    <>
      <SiteHeader />
      <main>

        {/* ── Hero ──────────────────────────────────────────────── */}
        <div className="relative overflow-hidden bg-surface pb-16 pt-24">
          <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-[480px] w-[640px] -translate-x-1/2 rounded-full bg-accent/[0.06] blur-[100px]" />
          <DotPattern className="opacity-[0.30]" />
          <Container>
            <div className="relative z-10 grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-center">

              {/* Left: text */}
              <div>
                {/* i18n-ignore: brand name */}
                <Eyebrow className="mb-5">Plugin System</Eyebrow>
                <h1 className="mb-5 text-[clamp(2rem,4.5vw,3.2rem)] font-bold leading-[1.08] tracking-tight text-kb-text">
                  <GradientText shimmer>{t('heroTitleHighlight')}</GradientText>
                  <span className="block">{t('heroTitleRest')}</span>
                </h1>
                <p className="mb-8 max-w-[48ch] text-[1.05rem] leading-[1.75] text-muted">
                  {t('heroDescription')}
                </p>
                <div className="flex flex-wrap gap-3">
                  <Button variant="primary" size="lg" href={`/${locale}/install`}>
                    {t('heroInstallBtn')}
                  </Button>
                  <Button variant="secondary" size="lg" href="https://docs.kblabs.ru/plugins" target="_blank" rel="noopener noreferrer">
                    {t('heroDocsBtn')}
                  </Button>
                </div>
              </div>

              {/* Right: install terminal */}
              <div className="w-full overflow-hidden rounded-2xl border border-line shadow-lg">
                <div className="flex items-center gap-1.5 border-b border-line px-4 py-3" style={{ background: '#0f1117' }}>
                  <span className="h-3 w-3 rounded-full bg-red-500/70" />
                  <span className="h-3 w-3 rounded-full bg-amber-500/70" />
                  <span className="h-3 w-3 rounded-full bg-emerald-500/70" />
                  {/* i18n-ignore: terminal label */}
                  <span className="ml-2 font-mono text-[0.65rem] text-white/25">terminal</span>
                </div>
                <div className="space-y-4 p-5 font-mono text-[0.78rem] leading-[1.7]" style={{ background: '#0f1117', color: '#e2e6f0' }}>
                  <div>
                    <span className="text-emerald-400/80">$ </span>
                    {/* i18n-ignore: terminal command */}
                    <span className="text-white/90">kb marketplace install @kb-labs/review</span>
                  </div>
                  <div className="space-y-0.5 text-white/50">
                    {/* i18n-ignore: terminal output */}
                    <div>  Resolving @kb-labs/review@2.94.0</div>
                    {/* i18n-ignore: terminal output */}
                    <div>  Installing via pnpm ...</div>
                  </div>
                  <div className="space-y-1.5">
                    <div>
                      <span className="text-emerald-400">✓ </span>
                      {/* i18n-ignore: terminal output */}
                      <span className="text-white/80">CLI commands registered</span>
                    </div>
                    {/* i18n-ignore: terminal output */}
                    <div className="pl-4 text-white/40">kb review&nbsp;&nbsp;&nbsp;&nbsp;kb review run&nbsp;&nbsp;&nbsp;&nbsp;kb review:ci</div>
                    <div>
                      <span className="text-emerald-400">✓ </span>
                      {/* i18n-ignore: terminal output */}
                      <span className="text-white/80">REST routes mounted</span>
                    </div>
                    {/* i18n-ignore: terminal output */}
                    <div className="pl-4 text-white/40">POST /api/review&nbsp;&nbsp;&nbsp;&nbsp;GET /api/review/runs</div>
                    <div>
                      <span className="text-emerald-400">✓ </span>
                      {/* i18n-ignore: terminal output */}
                      <span className="text-white/80">Studio page ready</span>
                    </div>
                    {/* i18n-ignore: terminal output */}
                    <div className="pl-4 text-white/40">/p/review</div>
                  </div>
                </div>
              </div>

            </div>
          </Container>
        </div>

        {/* ── Stats ─────────────────────────────────────────────── */}
        <Section className="border-y border-line bg-bg py-10">
          <Container>
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
              {plugStats.map((s) => (
                <AnimateOnScroll key={s.label} animation="slide-up">
                  <StatCard value={s.value} label={s.label} />
                </AnimateOnScroll>
              ))}
            </div>
          </Container>
        </Section>

        {/* ── Platform abstractions ─────────────────────────────── */}
        <Section>
          <Container>
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-start">

              {/* Left: code (height-capped, scrollable) */}
              <AnimateOnScroll animation="slide-up">
                <div className="overflow-auto rounded-2xl" style={{ maxHeight: 480 }}>
                  <CodeBlock
                    code={HANDLER_CODE}
                    language="typescript"
                    filename="task-create.ts"
                    bare
                  />
                </div>
              </AnimateOnScroll>

              {/* Right: text */}
              <AnimateOnScroll animation="slide-up" delay={100}>
                <SectionHeader
                  eyebrow={t('sdkEyebrow')}
                  title={t('sdkTitle')}
                />
                <div className="mb-8 space-y-4 text-[1rem] leading-[1.75] text-muted">
                  <p>
                    {t('sdkLead1')}
                  </p>
                  <p>
                    {t('sdkLead2')}
                  </p>
                </div>
                <Button variant="secondary" size="md" href="https://docs.kblabs.ru/plugins" target="_blank" rel="noopener noreferrer">
                  {t('sdkDocsBtn')}
                  <ExternalLink className="size-4" />
                </Button>
              </AnimateOnScroll>

            </div>
          </Container>
        </Section>

        {/* ── One manifest — three surfaces ─────────────────────── */}
        <Section className="bg-bg">
          <Container>
            <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-center">

              {/* Left: diagram */}
              <AnimateOnScroll animation="slide-up">
                <PluginSurfaceDiagram className="w-full max-w-[420px] mx-auto lg:mx-0" />
              </AnimateOnScroll>

              {/* Right: text */}
              <AnimateOnScroll animation="slide-up" delay={120}>
                <SectionHeader
                  eyebrow={t('surfaceEyebrow')}
                  title={t('surfaceTitle')}
                />
                <div className="space-y-4 text-[1rem] leading-[1.75] text-muted">
                  <p>
                    {t('surfaceLead1')}
                  </p>
                  <p>
                    {t('surfaceLead2')}
                  </p>
                  <p>
                    {t('surfaceLead3')}
                  </p>
                </div>
              </AnimateOnScroll>

            </div>
          </Container>
        </Section>

        {/* ── Lifecycle ─────────────────────────────────────────── */}
        <Section>
          <Container>
            <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-start">

              {/* Left: text */}
              <AnimateOnScroll animation="slide-up">
                <SectionHeader
                  eyebrow={t('lifecycleEyebrow')}
                  title={t('lifecycleTitle')}
                />
                <div className="space-y-4 text-[1rem] leading-[1.75] text-muted">
                  <p>
                    {t('lifecycleLead1')}
                  </p>
                  <p>
                    {t('lifecycleLead2')}
                  </p>
                  <p>
                    {t('lifecycleLead3')}
                  </p>
                </div>
              </AnimateOnScroll>

              {/* Right: lifecycle diagram */}
              <AnimateOnScroll animation="slide-up" delay={100}>
                <PluginLifecycleDiagram
                  className="w-full"
                  subtitles={{
                    manifest: t('lifecycleDiagram.manifest'),
                    install: t('lifecycleDiagram.install'),
                    discover: t('lifecycleDiagram.discover'),
                    register: t('lifecycleDiagram.register'),
                    execute: t('lifecycleDiagram.execute'),
                  }}
                />
              </AnimateOnScroll>

            </div>
          </Container>
        </Section>

        {/* ── Permissions ───────────────────────────────────────── */}
        <Section>
          <Container>
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.3fr] lg:items-start">

              {/* Left: text */}
              <AnimateOnScroll animation="slide-up">
                <SectionHeader
                  eyebrow={t('permEyebrow')}
                  title={t('permTitle')}
                />
                <div className="space-y-4 text-[1rem] leading-[1.75] text-muted">
                  <p>
                    {t('permLead1')}
                  </p>
                  <p>
                    {t('permLead2')}
                  </p>
                  <p>
                    {t('permLead3')}
                  </p>
                </div>
              </AnimateOnScroll>

              {/* Right: manifest code */}
              <AnimateOnScroll animation="slide-up" delay={100}>
                <CodeBlock
                  code={MANIFEST_CODE}
                  language="typescript"
                  filename="manifest.ts"
                  bare
                />
              </AnimateOnScroll>

            </div>
          </Container>
        </Section>

        {/* ── Create & publish ──────────────────────────────────── */}
        <Section className="bg-bg">
          <Container>
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-start">

              {/* Left: code */}
              <AnimateOnScroll animation="slide-up">
                <CodeBlock
                  code={SCAFFOLD_CODE}
                  language="bash"
                  filename="terminal"
                  bare
                />
              </AnimateOnScroll>

              {/* Right: text */}
              <AnimateOnScroll animation="slide-up" delay={100}>
                <SectionHeader
                  eyebrow={t('ecoEyebrow')}
                  title={t('ecoTitle')}
                />
                <div className="space-y-5">
                  {plugEcoSteps.map((item) => (
                    <div key={item.step} className="flex gap-4">
                      <span className="mt-0.5 flex-shrink-0 font-mono text-[0.7rem] font-bold text-accent/40">
                        {item.step}
                      </span>
                      <div>
                        <div className="text-[0.9rem] font-semibold text-kb-text">{item.title}</div>
                        <div className="text-[0.85rem] leading-[1.6] text-muted">{item.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </AnimateOnScroll>

            </div>
          </Container>
        </Section>

        {/* ── CTA ───────────────────────────────────────────────── */}
        <Section>
          <Container>
            <AnimateOnScroll animation="slide-up">
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
                    <Button variant="secondary" size="lg" href="https://docs.kblabs.ru/plugins" target="_blank" rel="noopener noreferrer">
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
