import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UIInputSearch,
  UISpin,
  UIEmptyState,
  UIMessage,
  UIButton,
  UIIcon,
  UIRow,
  UICol,
  UIPage,
  UIPageHeader,
  UISegmented,
  UITag,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import type { PluginManifestEntry } from '@kb-labs/studio-data-client';
import { MarketplaceCard } from '../components/marketplace-card';
import { useActiveProject } from '@/providers/active-project-provider';

type KindFilter = 'all' | 'plugins' | 'adapters';
type SurfaceFilter = 'all' | 'cli' | 'studio' | 'rest';

export function PluginsPage() {
  const navigate = useNavigate();
  const { plugins: pluginsSource } = useDataSources();
  const { activeProjectId, projects } = useActiveProject();
  const activeProject = projects?.find((project) => project.id === activeProjectId);

  const [loading, setLoading] = useState(true);
  const [plugins, setPlugins] = useState<PluginManifestEntry[]>([]);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
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
    plugins: plugins.length,
    adapters: 0,
    cli: plugins.filter(p => (p.manifest.cli?.commands?.length ?? 0) > 0).length,
    studio: plugins.filter(p => (p.manifest.studio?.pages?.length ?? 0) > 0).length,
    rest: plugins.filter(p => (p.manifest.rest?.routes?.length ?? 0) > 0).length,
  }), [plugins]);

  const filtered = useMemo(() => {
    return plugins.filter(p => {
      // This page only fetches the plugin registry — there's no adapter
      // registry wired in yet, so every entry here is a plugin/extension.
      if (kindFilter === 'adapters') {return false;}
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
  }, [plugins, search, surfaceFilter, kindFilter]);

  const handleClick = (plugin: PluginManifestEntry) => {
    navigate(`/marketplace/${encodeURIComponent(plugin.pluginId)}`);
  };

  const kindTabs: { key: KindFilter; label: string; count: number }[] = [
    { key: 'all',      label: 'All',      count: counts.all },
    { key: 'plugins',  label: 'Extensions',  count: counts.plugins },
    { key: 'adapters', label: 'Adapters', count: counts.adapters },
  ];

  const surfaceChips: { key: SurfaceFilter; label: string; count: number }[] = [
    { key: 'cli',    label: 'CLI',       count: counts.cli },
    { key: 'studio', label: 'Studio UI', count: counts.studio },
    { key: 'rest',   label: 'REST API',  count: counts.rest },
  ];

  if (loading) {
    return (
      <UIPage width="full">
        <div style={{ textAlign: 'center', padding: '80px 0' }}>
          <UISpin size="large" />
        </div>
      </UIPage>
    );
  }

  return (
    <UIPage width="full">
      <UIPageHeader
        title="Marketplace"
        description={activeProject
          ? `${counts.all} extensions available · project target: ${activeProject.title}`
          : `${counts.all} extensions available · choose a project in the sidebar to manage project extensions`}
        actions={
          <UIButton variant="primary" onClick={() => navigate('/plugins')} disabled={!activeProjectId}>
            Manage project extensions
          </UIButton>
        }
      />

      {/* Filters bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>

        {/* Kind tabs */}
        <UISegmented
          value={kindFilter}
          onChange={value => setKindFilter(value as KindFilter)}
          options={kindTabs.map(tab => ({
            label: (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px' }}>
                {tab.label}
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{tab.count}</span>
              </span>
            ),
            value: tab.key,
          }))}
        />

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
