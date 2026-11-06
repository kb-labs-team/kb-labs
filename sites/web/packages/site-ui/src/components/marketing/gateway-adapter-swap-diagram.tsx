'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface GatewayAdapterSwapDiagramProps {
  className?: string;
  caption: string;
}

// KB Labs services — shown in a 2×2 grid so they never wrap awkwardly
const CONSUMERS_OWN   = ['REST API', 'Workflow', 'Marketplace'];
const CONSUMER_YOURS  = 'your-service';

type ProviderColor = 'emerald' | 'accent' | 'amber' | 'red' | 'neutral';

const ADAPTERS: {
  name:      string;
  providers: { label: string; color: ProviderColor }[];
  interval:  number;
  offset:    number;
}[] = [
  {
    name: 'llm',
    providers: [
      { label: 'OpenAI',    color: 'emerald' },
      { label: 'Anthropic', color: 'accent'  },
      { label: 'Ollama',    color: 'neutral' },
    ],
    interval: 2800,
    offset: 0,
  },
  {
    name: 'eventBus',
    providers: [
      { label: 'Redis',    color: 'red'   },
      { label: 'Custom adapter', color: 'amber' },
    ],
    interval: 3200,
    offset: 950,
  },
  {
    name: 'storage',
    providers: [
      { label: 'S3',    color: 'amber'   },
      { label: 'local', color: 'neutral' },
      { label: 'GCS',   color: 'accent'  },
    ],
    interval: 3600,
    offset: 1900,
  },
];

const CHIP_CLS: Record<ProviderColor, string> = {
  emerald: 'bg-emerald-500/10 text-emerald-600/85 ring-emerald-500/20',
  accent:  'bg-accent/10 text-accent/80 ring-accent/20',
  amber:   'bg-amber-500/10 text-amber-600/80 ring-amber-500/20',
  red:     'bg-red-500/10 text-red-500/75 ring-red-500/20',
  neutral: 'bg-bg text-muted/55 ring-line',
};

export function GatewayAdapterSwapDiagram({ className, caption }: GatewayAdapterSwapDiagramProps) {
  const [visible, setVisible] = React.useState(false);
  const [indices, setIndices] = React.useState([0, 0, 0]);

  const rootRef    = React.useRef<HTMLDivElement>(null);
  const timers     = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  const hasStarted = React.useRef(false);

  // Start on intersection
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || hasStarted.current) return;
        hasStarted.current = true;
        setVisible(true);
      },
      { threshold: 0.2 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Cycle each adapter independently
  React.useEffect(() => {
    if (!visible) return;

    ADAPTERS.forEach((adapter, i) => {
      const tick = () => {
        setIndices(prev => {
          const next = [...prev];
          next[i] = (next[i] + 1) % adapter.providers.length;
          return next;
        });
        const id = setTimeout(tick, adapter.interval);
        timers.current.push(id);
      };
      const startId = setTimeout(tick, adapter.offset + adapter.interval);
      timers.current.push(startId);
    });

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [visible]);

  const fad = (v: boolean): React.CSSProperties => ({
    opacity:    v ? 1 : 0,
    transform:  v ? 'translateY(0)' : 'translateY(8px)',
    transition: 'opacity 0.4s ease, transform 0.4s ease',
  });

  return (
    <div ref={rootRef} className={cn('w-full select-none', className)}>
      <style>{`
        @keyframes kb-swap {
          from { opacity: 0; transform: translateY(5px); }
          to   { opacity: 1; transform: translateY(0);   }
        }
      `}</style>

      {/* Consumer chips — static, never change */}
      <div style={fad(visible)} className="flex items-center justify-center gap-2">
        {CONSUMERS_OWN.map(label => (
          <div key={label} className="rounded-lg border border-line bg-surface px-3 py-1.5 flex-shrink-0">
            <span className="font-mono text-[0.68rem] text-kb-text/60">{label}</span>
          </div>
        ))}
        <div className="rounded-lg border border-dashed border-line-strong/50 dark:border-line/40 px-3 py-1.5 flex-shrink-0">
          <span className="font-mono text-[0.65rem] text-muted/50 dark:text-muted/30">{CONSUMER_YOURS}</span>
        </div>
      </div>

      {/* Connector ↓ */}
      <div style={fad(visible)} className="flex justify-center" aria-hidden="true">
        <div className="w-px bg-line-strong" style={{ height: 24 }} />
      </div>

      {/* Gateway box */}
      <div style={fad(visible)} className="rounded-2xl border border-accent/30 bg-accent/[0.04] px-5 py-3.5 text-center">
        <span className="font-mono text-sm font-bold text-kb-text">Gateway</span>
        <span className="ml-2 font-mono text-sm text-muted/55 dark:text-muted/40">:4000</span>
      </div>

      {/* Connector ↓ */}
      <div style={fad(visible)} className="flex justify-center" aria-hidden="true">
        <div className="w-px bg-line-strong" style={{ height: 24 }} />
      </div>

      {/* Adapter rows — animated */}
      <div style={fad(visible)} className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
        {ADAPTERS.map((adapter, i) => {
          const provider = adapter.providers[indices[i]];
          return (
            <div
              key={adapter.name}
              className={cn(
                'flex items-center gap-4 px-5 py-3.5',
                i < ADAPTERS.length - 1 && 'border-b border-line',
              )}
            >
              {/* Adapter name */}
              <span className="w-[5.5rem] flex-shrink-0 font-mono text-[0.68rem] text-muted/60 dark:text-muted/45">
                {adapter.name}
              </span>

              {/* Provider chip — key change triggers fade-in animation */}
              <span
                key={`${i}-${indices[i]}`}
                style={{ animation: 'kb-swap 0.35s ease' }}
                className={cn(
                  'rounded-md px-2.5 py-0.5 font-mono text-[0.7rem] font-medium ring-1 ring-inset',
                  CHIP_CLS[provider.color],
                )}
              >
                {provider.label}
              </span>

              {/* Swap indicator */}
              <span className="ml-auto font-mono text-[0.65rem] text-muted/40 dark:text-muted/50">⇄</span>
            </div>
          );
        })}
      </div>

      {/* Caption */}
      <p style={fad(visible)} className="mt-3 text-center font-mono text-[0.72rem] text-muted/60 dark:text-muted/30">
        {caption}
      </p>
    </div>
  );
}
