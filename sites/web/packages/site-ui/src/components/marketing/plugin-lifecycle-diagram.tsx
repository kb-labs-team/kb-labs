'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface PluginLifecycleDiagramProps {
  className?: string;
  subtitles: Record<'manifest' | 'install' | 'discover' | 'register' | 'execute', string>;
}

// ── Stage definitions ──────────────────────────────────────────────────────

const STAGES = [
  {
    id:     'manifest',
    label:  'manifest.ts',
    subtitle: 'manifest',
    kind:   'source' as const,
    chips:  [
      { label: "schema: 'kb.plugin/3'", color: 'accent' },
      { label: 'permissions',           color: 'accent' },
      { label: 'capabilities',          color: 'accent' },
    ],
  },
  {
    id:     'install',
    label:  'Install',
    subtitle: 'install',
    kind:   'step' as const,
    chips:  [
      { label: 'pnpm install',          color: 'neutral' },
      { label: '.kb/marketplace.lock',  color: 'neutral' },
      { label: 'sha256 integrity',      color: 'neutral' },
    ],
  },
  {
    id:     'discover',
    label:  'Discover',
    subtitle: 'discover',
    kind:   'step' as const,
    chips:  [
      { label: 'enabled check',     color: 'neutral' },
      { label: 'integrity verify',  color: 'neutral' },
      { label: 'loadManifest()',    color: 'neutral' },
    ],
  },
  {
    id:     'register',
    label:  'Register',
    subtitle: 'register',
    kind:   'fanout' as const,
    chips:  [
      { label: 'cli-command',   color: 'emerald' },
      { label: 'rest-route',    color: 'emerald' },
      { label: 'studio-page',   color: 'purple'  },
      { label: 'workflow',      color: 'emerald' },
      { label: 'webhook',       color: 'emerald' },
      { label: 'ws-channel',    color: 'emerald' },
      { label: 'cron',          color: 'emerald' },
    ],
  },
  {
    id:     'execute',
    label:  'Execute',
    subtitle: 'execute',
    kind:   'backends' as const,
    chips:  [
      { label: 'in-process',         color: 'neutral' },
      { label: 'subprocess',         color: 'amber'   },
      { label: 'worker-pool',        color: 'amber'   },
      { label: 'remote · OS isolate', color: 'red'    },
    ],
  },
] as const;

type StageKind   = typeof STAGES[number]['kind'];
type ChipColor   = 'accent' | 'emerald' | 'purple' | 'amber' | 'red' | 'neutral';

// ── Chip color classes ─────────────────────────────────────────────────────

const CHIP_CLS: Record<ChipColor, string> = {
  accent:  'bg-accent/10 text-accent/80 ring-accent/20',
  emerald: 'bg-emerald-500/10 text-emerald-600/80 ring-emerald-500/20',
  purple:  'bg-purple-500/10 text-purple-600/80 ring-purple-500/20',
  amber:   'bg-amber-500/10 text-amber-600/80 ring-amber-500/20',
  red:     'bg-red-500/10 text-red-500/75 ring-red-500/20',
  neutral: 'bg-bg text-muted/55 ring-line',
};

// ── Border / bg per stage kind ─────────────────────────────────────────────

const STAGE_CLS: Record<StageKind, string> = {
  source:   'border-accent/25 bg-accent/[0.03]',
  step:     'border-line bg-surface',
  fanout:   'border-emerald-200/50 bg-surface dark:border-emerald-900/40',
  backends: 'border-line bg-surface',
};

// ── Component ──────────────────────────────────────────────────────────────

export function PluginLifecycleDiagram({ className, subtitles }: PluginLifecycleDiagramProps) {
  const [visCount, setVisCount] = React.useState(0);

  const rootRef    = React.useRef<HTMLDivElement>(null);
  const timers     = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  const hasStarted = React.useRef(false);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || hasStarted.current) return;
        hasStarted.current = true;

        STAGES.forEach((_, i) => {
          const id = setTimeout(() => setVisCount(i + 1), i * 200);
          timers.current.push(id);
        });
      },
      { threshold: 0.2 }
    );

    obs.observe(el);
    return () => {
      obs.disconnect();
      timers.current.forEach(clearTimeout);
    };
  }, []);

  return (
    <div ref={rootRef} className={cn('w-full select-none', className)}>
      <div className="flex flex-col items-center gap-0">
        {STAGES.map((stage, i) => {
          const visible = i < visCount;

          return (
            <React.Fragment key={stage.id}>
              {/* Stage card */}
              <div
                className={cn(
                  'w-full rounded-2xl border p-5 shadow-sm',
                  'transition-all duration-400 ease-out',
                  STAGE_CLS[stage.kind],
                  visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
                )}
                style={{ transitionDelay: visible ? '0ms' : '0ms' }}
              >
                {/* Header */}
                <div className="mb-3 flex items-baseline gap-2">
                  <span className="font-mono text-[0.95rem] font-bold text-kb-text">
                    {stage.label}
                  </span>
                  <span className="font-mono text-[0.7rem] text-muted/60 dark:text-muted/45">{subtitles[stage.subtitle]}</span>
                </div>

                {/* Chips */}
                <div className="flex flex-wrap gap-1.5">
                  {stage.chips.map((chip) => (
                    <span
                      key={chip.label}
                      className={cn(
                        'rounded-md px-2 py-0.5 font-mono text-[0.62rem] font-medium ring-1 ring-inset',
                        CHIP_CLS[chip.color as ChipColor],
                      )}
                    >
                      {chip.label}
                    </span>
                  ))}
                </div>
              </div>

              {/* Connector line */}
              {i < STAGES.length - 1 && (
                <div
                  className={cn(
                    'w-px bg-line-strong transition-opacity duration-300',
                    visible ? 'opacity-100' : 'opacity-0',
                  )}
                  style={{ height: 24 }}
                  aria-hidden="true"
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
