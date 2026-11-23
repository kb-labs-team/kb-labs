import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UIInputSearch,
  UISkeleton,
  UIEmptyState,
  UIRow,
  UICol,
  UIPage,
  UIPageHeader,
  UITag,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import type { PluginManifestEntry } from '@kb-labs/studio-data-client';
import { MarketplaceCard } from '../components/marketplace-card';
import { EmptyState } from '@/components/empty-state';

type SurfaceFilter = 'all' | 'cli' | 'studio' | 'rest';

export function PluginsPage() {
  const navigate = useNavigate();
  const { plugins: pluginsSource } = useDataSources();

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [plugins, setPlugins] = useState<PluginManifestEntry[]>([]);
  const [search, setSearch] = useState('');
  const [surfaceFilter, setSurfaceFilter] = useState<SurfaceFilter>('all');

  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true);
      setLoadFailed(false);
      const result = await pluginsSource.getPlugins();
      setPlugins(result.manifests);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [pluginsSource]);

  useEffect(() => { loadPlugins(); }, [loadPlugins]);

  const counts = useMemo(() => ({
    all: plugins.length,
    cli: plugins.filter(p => (p.manifest.cli?.commands?.length ?? 0) > 0).length,
    studio: plugins.filter(p => (p.manifest.studio?.pages?.length ?? 0) > 0).length,
    rest: plugins.filter(p => (p.manifest.rest?.routes?.length ?? 0) > 0).length,
  }), [plugins]);

  const filtered = useMemo(() => {
    return plugins.filter(p => {
      const m = p.manifest;
      if (search) {
        const q = search.toLowerCase();
        const text = [m.id, m.display?.name, m.display?.description, ...(m.display?.tags ?? [])].join(' ').toLowerCase();
        if (!text.includes(q)) {return false;}
      }
      if (surfaceFilter === 'cli' && !((m.cli?.commands?.length ?? 0) > 0)) {return false;}
      if (surfaceFilter === 'studio' && !((m.studio?.pages?.length ?? 0) > 0)) {return false;}
      if (surfaceFilter === 'rest' && !((m.rest?.routes?.length ?? 0) > 0)) {return false;}
      return true;
    });
  }, [plugins, search, surfaceFilter]);

  const handleClick = (plugin: PluginManifestEntry) => {
    navigate(`/marketplace/${encodeURIComponent(plugin.pluginId)}`);
  };

  const surfaceChips: { key: SurfaceFilter; label: string; count: number }[] = [
    { key: 'cli',    label: 'CLI',       count: counts.cli },
    { key: 'studio', label: 'Studio UI', count: counts.studio },
    { key: 'rest',   label: 'REST API',  count: counts.rest },
  ];

  if (loading) {
    return (
      <UIPage width="full">
        <UISkeleton active avatar lines={6} />
      </UIPage>
    );
  }

  if (loadFailed) {
    return (
      <UIPage width="full">
        <UIPageHeader title="Marketplace" description="Plugin catalog status" />
        <EmptyState
          kind="unavailable"
          title="Marketplace unavailable"
          description="The plugin catalog could not be loaded. Try again when the Gateway is available."
          action={{ label: 'Retry', onClick: loadPlugins }}
        />
      </UIPage>
    );
  }

  return (
    <UIPage width="full">
      <UIPageHeader
        title="Marketplace"
        description={`${counts.all} extension${counts.all !== 1 ? 's' : ''} in the catalog`}
      />

      {/* Filters bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>

        {/* Surface chips */}
        <div style={{ display: 'flex', gap: 6 }}>
          {surfaceChips.map(chip => {
            const active = surfaceFilter === chip.key;
            return (
              <UITag
                key={chip.key}
                variant={active ? 'info' : 'neutral'}
                onClick={() => setSurfaceFilter(active ? 'all' : chip.key)}
                style={{ margin: 0, fontSize: 12, padding: '3px 10px' }}
              >
                {chip.label} <span style={{ opacity: 0.7 }}>{chip.count}</span>
              </UITag>
            );
          })}
        </div>

        {/* Search — pushed to the right */}
        <div style={{ marginLeft: 'auto' }}>
          <UIInputSearch
            placeholder="Search extensions..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            allowClear
            style={{ width: 260 }}
          />
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <UIEmptyState
          description={search ? 'No extensions match your search' : 'No extensions found'}
          style={{ marginTop: 48 }}
        />
      ) : (
        <UIRow gutter={[16, 16]}>
          {filtered.map(plugin => (
            <UICol key={plugin.pluginId} xs={24} sm={12} xl={8}>
              <MarketplaceCard plugin={plugin} onClick={() => handleClick(plugin)} />
            </UICol>
          ))}
        </UIRow>
      )}
    </UIPage>
  );
}
