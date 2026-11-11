import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { CommandField } from '@/components/CommandField';
import { PlatformCommand, PlatformBinaryTable } from '@/components/platform';
import { buildPageMetadata } from '@/lib/page-metadata';
import {
  AnimateOnScroll,
  Button,
  Container,
  DotPattern,
  Eyebrow,
  GlowCard,
  GradientText,
  Section,
} from '@kb-labs/web-site-ui';
import {
  BookOpen,
  CheckCircle2,
  Download,
  FolderOpen,
  Layers,
  Lightbulb,
  Monitor,
  Package,
  Play,
  Terminal,
} from 'lucide-react';

type Props = { params: Promise<{ locale: string }> };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return buildPageMetadata({
    locale,
    title: t('install.meta.title'),
    description: t('install.meta.description'),
    path: '/install',
    imageSegment: 'install',
  });
}

const FALLBACK_TAG = 'v0.4.0-binaries';

async function getLatestBinariesTag(): Promise<string> {
  try {
    const res = await fetch(
      'https://api.github.com/repos/kb-labs-team/kb-labs/releases?per_page=20',
      { next: { revalidate: 3600 }, headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return FALLBACK_TAG;
    const releases = (await res.json()) as Array<{ tag_name?: string; draft?: boolean }>;
    const hit = releases.find(
      (r) => !r.draft && typeof r.tag_name === 'string' && r.tag_name.endsWith('-binaries'),
    );
    return hit?.tag_name ?? FALLBACK_TAG;
  } catch {
    return FALLBACK_TAG;
  }
}

export default async function InstallPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });

  const latestTag = await getLatestBinariesTag();
  const pinUnix = `curl -fsSL https://kblabs.ru/install.sh | sh -s -- --version ${latestTag}`; // i18n-ignore
  const checksumCmd = `curl -fsSL https://github.com/kb-labs-team/kb-labs/releases/download/${latestTag}/checksums.txt | grep kb-create-linux-amd64`; // i18n-ignore

  const PREREQS = [
    { icon: Package,  label: 'Node.js (supported major)',       note: 'nodejs.org/en/download' }, // i18n-ignore
    { icon: Terminal, label: 'pnpm',                            note: 'npm install -g pnpm' }, // i18n-ignore
    { icon: Monitor,  label: t('install.prereqs.os'),           note: t('install.prereqs.osNote') },
  ];

  const STEPS = [
    {
      icon: Download,
      num: '01',
      title: t('install.quickInstall.steps.0.title'),
      cmd: 'curl -fsSL https://kblabs.ru/install.sh | sh', // i18n-ignore
      note: t('install.quickInstall.steps.0.note'),
      usePlatform: true,
    },
    {
      icon: FolderOpen,
      num: '02',
      title: t('install.quickInstall.steps.1.title'),
      cmd: 'kb-create my-project --engine', // i18n-ignore
      note: t('install.quickInstall.steps.1.note'),
      usePlatform: false,
    },
    {
      icon: CheckCircle2,
      num: '03',
      title: t('install.quickInstall.steps.2.title'),
      cmd: 'kb-create status', // i18n-ignore
      note: t('install.quickInstall.steps.2.note'),
      usePlatform: false,
    },
  ];

  const AFTER = [
    {
      icon: Play,
      title: t('install.afterInstall.steps.0.title'),
      cmd: 'cd my-project && kb-dev start', // i18n-ignore
    },
    {
      icon: BookOpen,
      title: t('install.afterInstall.steps.1.title'),
      href: 'https://docs.kblabs.ru',
      linkLabel: 'docs.kblabs.ru →', // i18n-ignore
      external: true,
    },
    {
      icon: Package,
      title: t('install.afterInstall.installPlugin'),
      cmd: 'kb marketplace install @kb-labs/commit', // i18n-ignore
    },
    {
      icon: Lightbulb,
      title: t('install.afterInstall.examples'),
      href: '/use-cases',
      linkLabel: t('install.afterInstall.examplesLink'),
      external: false,
    },
  ];

  return (
    <>
      <SiteHeader />
      <main>

        {/* ── Hero ── */}
        <section className="relative overflow-hidden border-b border-line py-12 pb-10 sm:py-24 sm:pb-20">
          <DotPattern className="absolute inset-0 z-0 opacity-40" />
          <Container className="relative z-10">
            <AnimateOnScroll>
              <div className="mx-auto max-w-3xl text-center">
                <Eyebrow className="mb-4">{t('install.hero.eyebrow2')}</Eyebrow>
                <h1 className="mb-6 text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
                  <GradientText>{t('install.hero.titleLine1')}</GradientText>
                  <br />
                  <span className="text-kb-text">{t('install.hero.titleLine2')}</span>
                </h1>
                <p className="mx-auto mb-10 max-w-xl text-lg leading-relaxed text-muted/70">
                  {t('install.hero.description2')}
                </p>
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-end sm:justify-center">
                  <PlatformCommand commands={{ unix: 'curl -fsSL https://kblabs.ru/install.sh | sh' }} className="w-full sm:w-auto sm:min-w-[360px]" /> {/* i18n-ignore */}
                  <Button
                    variant="secondary"
                    size="lg"
                    href="https://github.com/kb-labs-team/kb-labs/releases/latest"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('install.hero.releasesBtn')}
                  </Button>
                </div>
              </div>
            </AnimateOnScroll>
          </Container>
        </section>

        {/* ── Prerequisites ── */}
        <Section className="border-b border-line bg-surface/40">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto max-w-2xl">
                <Eyebrow className="mb-6">{t('install.prerequisites.title')}</Eyebrow>
                <div className="grid gap-3 sm:grid-cols-3 sm:items-stretch">
                  {PREREQS.map((p, i) => {
                    const Icon = p.icon;
                    return (
                      <AnimateOnScroll key={p.label} delay={i * 50} className="h-full">
                        <div className="flex h-full flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
                          <div className="flex size-9 items-center justify-center rounded-lg border border-line bg-bg text-muted">
                            <Icon size={16} />
                          </div>
                          <div className="flex flex-col gap-1">
                            <p className="text-sm font-semibold text-kb-text">{p.label}</p>
                            <p className="text-sm text-muted/50 break-words">{p.note}</p>
                          </div>
                        </div>
                      </AnimateOnScroll>
                    );
                  })}
                </div>
              </div>
            </AnimateOnScroll>
          </Container>
        </Section>

        {/* ── Quick Install steps ── */}
        <Section className="border-b border-line">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto max-w-2xl">
                <Eyebrow className="mb-4">{t('install.quickInstall.title')}</Eyebrow>
                <h2 className="mb-8 text-3xl font-bold tracking-tight text-kb-text">
                  {t('install.quickInstall.heading')}
                </h2>
                <div className="overflow-hidden rounded-2xl border border-line bg-surface divide-y divide-line">
                  {STEPS.map((step) => {
                    const Icon = step.icon;
                    return (
                      <div key={step.num} className="flex gap-5 px-5 py-5">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-bg text-muted">
                          <Icon size={17} />
                        </div>
                        <div className="flex-1 space-y-3 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[0.65rem] font-bold text-muted/45 dark:text-muted/50">{step.num}</span>
                            <h3 className="text-sm font-semibold text-kb-text">{step.title}</h3>
                          </div>
                          {step.usePlatform ? (
                            <PlatformCommand commands={{ unix: step.cmd }} />
                          ) : (
                            <CommandField text={step.cmd} />
                          )}
                          <p className="text-sm text-muted/50">{step.note}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </AnimateOnScroll>
          </Container>
        </Section>

        {/* ── Pin version + Enterprise ── */}
        <Section className="border-b border-line bg-surface/40">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto max-w-2xl">
                <div className="grid gap-8 lg:grid-cols-2">

                  {/* Pin version */}
                  <div>
                    <Eyebrow className="mb-4">{t('install.pinVersion.title')}</Eyebrow>
                    <h2 className="mb-2 text-xl font-bold tracking-tight text-kb-text">{t('install.pinVersion.heading')}</h2>
                    <p className="mb-5 text-sm leading-relaxed text-muted/60">{t('install.pinVersion.description')}</p>
                    <PlatformCommand commands={{ unix: pinUnix }} />
                    <p className="mt-5 mb-2 text-sm font-semibold text-kb-text">{t('install.pinVersion.checksumTitle')}</p>
                    <CommandField text={checksumCmd} />
                  </div>

                  {/* Enterprise */}
                  <GlowCard className="flex flex-col justify-between rounded-2xl border border-line p-6">
                    <div>
                      <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-line bg-bg text-muted">
                        <Layers size={17} />
                      </div>
                      <Eyebrow className="mb-3">Enterprise</Eyebrow>
                      <p className="mb-6 text-sm leading-relaxed text-muted/60">
                        {t('install.enterprise.description')}
                      </p>
                    </div>
                    <Button variant="secondary" href={`/${locale}/enterprise`}>
                      {t('install.enterprise.link')}
                    </Button>
                  </GlowCard>

                </div>
              </div>
            </AnimateOnScroll>
          </Container>
        </Section>

        {/* ── Binaries ── */}
        <Section className="border-b border-line">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto max-w-2xl">
                <Eyebrow className="mb-4">{t('install.binaries.eyebrow')}</Eyebrow>
                <h2 className="mb-2 text-2xl font-bold tracking-tight text-kb-text">{t('install.binaries.heading')}</h2>
                <p className="mb-8 text-sm leading-relaxed text-muted/60">{t('install.binaries.subheading')}</p>
                <PlatformBinaryTable
                  binaries={[
                    { platform: 'macOS (Apple Silicon)', file: 'kb-create-darwin-arm64' }, // i18n-ignore
                    { platform: 'macOS (Intel)',         file: 'kb-create-darwin-amd64' }, // i18n-ignore
                    { platform: 'Linux (x86_64)',        file: 'kb-create-linux-amd64' }, // i18n-ignore
                    { platform: 'Linux (ARM64)',         file: 'kb-create-linux-arm64' }, // i18n-ignore
                  ]}
                  downloadLabel={t('install.binaries.downloadBtn')}
                  baseUrl="https://github.com/kb-labs-team/kb-labs/releases/latest/download"
                  colPlatform={t('install.binaries.colPlatform')}
                  colBinary={t('install.binaries.colBinary')}
                  colDownload={t('install.binaries.colDownload')}
                />
              </div>
            </AnimateOnScroll>
          </Container>
        </Section>

        {/* ── After install ── */}
        <Section className="bg-surface/40">
          <Container>
            <AnimateOnScroll>
              <div className="mx-auto max-w-2xl">
                <Eyebrow className="mb-4">{t('install.afterInstall.eyebrow')}</Eyebrow>
                <h2 className="mb-8 text-2xl font-bold tracking-tight text-kb-text">{t('install.afterInstall.heading')}</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {AFTER.map((item, i) => {
                    const Icon = item.icon;
                    return (
                      <AnimateOnScroll key={item.title} delay={i * 50}>
                        <GlowCard className="flex h-full flex-col gap-4 rounded-2xl border border-line p-5">
                          <div className="flex size-9 items-center justify-center rounded-lg border border-line bg-bg text-muted">
                            <Icon size={17} />
                          </div>
                          <p className="text-sm font-semibold text-kb-text">{item.title}</p>
                          {item.cmd ? (
                            <CommandField text={item.cmd} />
                          ) : (
                            <Button
                              variant="secondary"
                              size="sm"
                              href={item.external ? item.href : `/${locale}${item.href}`}
                              {...(item.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                            >
                              {item.linkLabel}
                            </Button>
                          )}
                        </GlowCard>
                      </AnimateOnScroll>
                    );
                  })}
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
