import { useDataSources } from '../providers/data-sources-provider';
import { useHealthStatus, useReadyStatus } from '@kb-labs/studio-data-client';
import { studioConfig } from '@/config/studio.config';
import { RefreshCw, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HealthStatus } from '@kb-labs/studio-data-client';
import styles from './health-banner.module.css';

export function HealthBanner() {
  const sources = useDataSources();
  const sseHealth = null as { status: string; ts?: string; ready: boolean; reason?: string } | null;
  const { data: healthRaw, error, refetch } = useHealthStatus(sources.system);
  const { data: ready } = useReadyStatus(sources.system);
  const [showDetails, setShowDetails] = useState(false);
  const lastRefetchedTs = useRef<string | null>(null);

  useEffect(() => {
    if (!sseHealth) {return;}
    const shouldRefetch =
      (!sseHealth.ready || sseHealth.status === 'degraded') &&
      sseHealth.ts &&
      sseHealth.ts !== lastRefetchedTs.current;
    if (shouldRefetch) {
      lastRefetchedTs.current = sseHealth.ts ?? null;
      void refetch();
    }
  }, [sseHealth, refetch]);

  const healthSnapshot = (healthRaw as Record<string, unknown> | undefined)?.snapshot as
    | HealthStatus['snapshot']
    | undefined;

  const fallbackStatus =
    healthSnapshot?.status ?? ((healthRaw as { ok?: boolean } | undefined)?.ok ? 'healthy' : 'unknown');
  const healthStatus = sseHealth?.status ?? fallbackStatus;
  const readyStatus = sseHealth?.ready ?? ready?.ready ?? true;
  const readyReason = !readyStatus
    ? sseHealth?.reason ?? (ready && 'reason' in ready ? ready.reason : undefined)
    : undefined;

  const impactedComponents = (healthSnapshot?.checks ?? [])
    .filter((check) => check.status !== 'ok')
    .map((check) => ({ id: check.id, lastError: check.message ?? 'unknown issue' }));

  const pluginMetrics = useMemo(() => {
    const meta = healthSnapshot?.meta as Record<string, unknown> | undefined;
    const pluginMounts = meta?.pluginMounts as Record<string, unknown> | undefined;
    const succeeded =
      pluginMounts && typeof pluginMounts.succeeded === 'number'
        ? (pluginMounts.succeeded as number)
        : undefined;
    const failed =
      pluginMounts && typeof pluginMounts.failed === 'number'
        ? (pluginMounts.failed as number)
        : undefined;
    if (succeeded === undefined && failed === undefined) {return null;}
    return { succeeded: succeeded ?? 0, failed: failed ?? 0 };
  }, [healthSnapshot]);

  const isDegraded =
    (healthStatus === 'degraded' || healthSnapshot?.state === 'partial_observability') && readyStatus;
  const isDown = !!error || !readyStatus;
  const isNotReady = !readyStatus;
  const isHealthUnavailable = !!error && readyStatus;
  const isMockMode =
    studioConfig.dataSourceMode === 'mock' ||
    (studioConfig.dataSourceMode === 'http' && !healthSnapshot && error);

  if (!isDegraded && !isDown && !isMockMode) {return null;}

  const variant = isDown ? 'error' : isDegraded ? 'warning' : 'info';

  const stripCls = {
    error: styles.stripError,
    warning: styles.stripWarning,
    info: styles.stripInfo,
  }[variant];

  const IconComponent = { error: AlertCircle, warning: AlertTriangle, info: Info }[variant];
  const iconSize = 14;

  const message = isDown
    ? isNotReady ? 'Gateway unavailable' : 'Gateway health details unavailable'
    : isDegraded
    ? 'Gateway degraded'
    : 'Mock mode';

  const description = isDown
    ? isNotReady
      ? `Source: gateway. Not ready at /api/ready${readyReason ? ` — ${readyReason}` : ''}. Run kb-create status --platform-root <platform-root> or kb-create doctor --platform-root <platform-root>.`
      : isHealthUnavailable
        ? 'Could not load health details from /api/observability/health. Retry the request or check Gateway logs.'
        : 'Gateway health details are unavailable.'
    : isDegraded
    ? `Some services may be unavailable${pluginMetrics?.failed ? ` · ${pluginMetrics.failed} plugin mount(s) failed` : ''}`
    : 'Using mock data for development';

  const hasDetails = isDegraded && impactedComponents.length > 0;

  return (
    <>
      <div className={`${styles.strip} ${stripCls}`}>
        <span className={styles.icon}>
          <IconComponent size={iconSize} />
        </span>
        <span className={styles.message}>{message}</span>
        <span className={styles.description}>{description}</span>
        {hasDetails && (
          <button
            type="button"
            className={styles.detailsBtn}
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? 'Hide details' : 'Details'}
          </button>
        )}
        <button
          type="button"
          className={styles.retryBtn}
          onClick={() => refetch()}
          title="Retry"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {showDetails && hasDetails && (
        <div className={styles.details}>
          <ul className={styles.detailsList}>
            {impactedComponents.map((c) => (
              <li key={c.id}>
                <strong>{c.id}</strong>: {c.lastError}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
