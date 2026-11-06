'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface PluginSurfaceDiagramProps {
  className?: string;
}

const PLUGINS = [
  {
    pkg:    '@kb-labs/review',
    cli:    { cmd: 'kb review --staged',       sub: 'kb review run' },
    rest:   { endpoint: 'POST /api/review',    sub: 'GET /api/review/runs' },
    studio: { path: '/p/review' },
  },
  {
    pkg:    '@kb-labs/commit',
    cli:    { cmd: 'kb commit',                sub: 'kb commit plan' },
    rest:   { endpoint: 'POST /api/commit',    sub: 'POST /api/commit/apply' },
    studio: { path: '/p/commit' },
  },
  {
    pkg:    '@kb-labs/release',
    cli:    { cmd: 'kb release plan',          sub: 'kb release publish' },
    rest:   { endpoint: 'POST /api/release',   sub: 'POST /api/release/publish' },
    studio: { path: '/p/release' },
  },
];

type Phase = 'idle' | 'pkg' | 'lines' | 's1' | 's2' | 's3' | 'out';

export function PluginSurfaceDiagram({ className }: PluginSurfaceDiagramProps) {
  const [pluginIdx, setPluginIdx] = React.useState(0);
  const [phase, setPhase]         = React.useState<Phase>('idle');

  const rootRef    = React.useRef<HTMLDivElement>(null);
  const timers     = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  const hasStarted = React.useRef(false);

  const clearTimers = React.useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const runAnimation = React.useCallback((idx: number) => {
    clearTimers();
    const t = (ms: number, fn: () => void) => {
      const id = setTimeout(fn, ms);
      timers.current.push(id);
    };
    setPluginIdx(idx);
    setPhase('pkg');
    t(400,  () => setPhase('lines'));
    t(750,  () => setPhase('s1'));
    t(1000, () => setPhase('s2'));
    t(1250, () => setPhase('s3'));
    t(4000, () => setPhase('out'));
    t(4600, () => runAnimation((idx + 1) % PLUGINS.length));
  }, [clearTimers]);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasStarted.current) {
          hasStarted.current = true;
          runAnimation(0);
        }
      },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => { obs.disconnect(); clearTimers(); };
  }, [runAnimation, clearTimers]);

  const plugin = PLUGINS[pluginIdx];
  const alive  = phase !== 'idle' && phase !== 'out';
  const lines  = alive && phase !== 'pkg';
  const s1 = alive && ['s1', 's2', 's3'].includes(phase);
  const s2 = alive && ['s2', 's3'].includes(phase);
  const s3 = alive && phase === 's3';

  const fad = (v: boolean): React.CSSProperties => ({
    opacity: v ? 1 : 0,
    transition: 'opacity 0.30s ease',
  });

  const row = (v: boolean): React.CSSProperties => ({
    opacity:   v ? 1 : 0,
    transform: v ? 'translateY(0)' : 'translateY(6px)',
    transition: 'opacity 0.30s ease, transform 0.30s ease',
  });

  return (
    <div ref={rootRef} className={cn('select-none w-full', className)}>

      {/* Package pill */}
      <div style={fad(alive)} className="flex justify-center mb-0">
        <div className="inline-flex items-center rounded-full border border-accent/25 bg-accent/[0.05] px-4 py-1.5 shadow-sm">
          <span className="font-mono text-[0.75rem] font-semibold text-accent/80">
            {plugin.pkg}
          </span>
        </div>
      </div>

      {/* Vertical connector */}
      <div style={fad(lines)} className="flex justify-center" aria-hidden="true">
        <div className="w-px bg-line-strong" style={{ height: 28 }} />
      </div>

      {/* Surface rows card */}
      <div
        style={fad(s1)}
        className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
      >
        {/* CLI */}
        <div style={row(s1)} className="flex items-center gap-4 border-b border-line px-5 py-3.5">
          <span className="flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.6rem] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-600/80 ring-1 ring-inset ring-emerald-500/20 w-[56px] text-center">
            CLI
          </span>
          <div className="min-w-0 flex-1">
            <code className="block truncate font-mono text-[0.78rem] text-kb-text/85">{plugin.cli.cmd}</code>
            <code className="block truncate font-mono text-[0.68rem] text-muted/55 dark:text-muted/40">{plugin.cli.sub}</code>
          </div>
        </div>

        {/* REST API */}
        <div style={row(s2)} className="flex items-center gap-4 border-b border-line px-5 py-3.5">
          <span className="flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.6rem] font-bold uppercase tracking-wider bg-accent/10 text-accent/80 ring-1 ring-inset ring-accent/20 w-[56px] text-center">
            REST
          </span>
          <div className="min-w-0 flex-1">
            <code className="block truncate font-mono text-[0.78rem] text-kb-text/85">{plugin.rest.endpoint}</code>
            <code className="block truncate font-mono text-[0.68rem] text-muted/55 dark:text-muted/40">{plugin.rest.sub}</code>
          </div>
        </div>

        {/* Studio */}
        <div style={row(s3)} className="flex items-center gap-4 px-5 py-3.5">
          <span className="flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.6rem] font-bold uppercase tracking-wider bg-purple-500/10 text-purple-600/80 ring-1 ring-inset ring-purple-500/20 w-[56px] text-center">
            Studio
          </span>
          <div className="min-w-0 flex-1">
            <code className="block truncate font-mono text-[0.78rem] text-kb-text/85">{plugin.studio.path}</code>
            <code className="block truncate font-mono text-[0.68rem] text-muted/55 dark:text-muted/40">full page</code>
          </div>
        </div>
      </div>

    </div>
  );
}
