import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UIInputSearch,
  UISkeleton,
  UIEmptyState,
  UIMessage,
  UIRow,
  UICol,
  UIPage,
  UIPageHeader,
  UITag,
  UITabs,
  type UITabItem,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import type { PluginManifestEntry } from '@kb-labs/studio-data-client';
import { MarketplaceCard } from '../components/marketplace-card';
import { InstalledProjectPlugins } from '../components/installed-project-plugins';

type SurfaceFilter = 'all' | 'cli' | 'studio' | 'rest';

export function PluginsPage() {
  const navigate = useNavigate();
  const { plugins: pluginsSource } = useDataSources();

  const [loading, setLoading] = useState(true);
  const [plugins, setPlugins] = useState<PluginManifestEntry[]>([]);
  const [search, setSearch] = useState('');
  const [surfaceFilter, setSurfaceFilter] = useState<SurfaceFilter>('all');

  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true);
      const result = await pluginsSource.getPlugins();
      setPlugins(result.manifests);
    } catch {
      UIMessage.error('Failed to load marketplace');
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

  const browseTab: UITabItem = {
    key: 'browse',
    label: 'Studio plugins',
    children: (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
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
          <div style={{ marginLeft: 'auto' }}>
            <UIInputSearch
              placeholder="Search Studio plugins..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              allowClear
              style={{ width: 260 }}
            />
          </div>
        </div>
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
      </>
    ),
  };

  const installedTab: UITabItem = {
    key: 'installed',
    label: 'Installed',
    children: <InstalledProjectPlugins />,
  };

  return (
    <UIPage width="full">
      <UIPageHeader
        title="Marketplace"
        description={`${counts.all} Studio plugin${counts.all !== 1 ? 's' : ''} discovered; manage project installs in Installed.`}
      />
      <UITabs items={[browseTab, installedTab]} defaultActiveKey="browse" syncUrl="search" />
    </UIPage>
  );
}
