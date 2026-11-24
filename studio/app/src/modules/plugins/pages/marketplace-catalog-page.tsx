import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  UIButton,
  UICard,
  UIEmptyState,
  UIInputSearch,
  UIMessage,
  UIPage,
  UIPageHeader,
  UISkeleton,
  UITag,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import { useProjectContext } from '@/providers/project-context-provider';
import { useInstallProjectPlugin } from '@kb-labs/studio-data-client';
import type { MarketplacePackageSummary, MarketplaceRegistryPackage } from '@kb-labs/studio-data-client';

export function MarketplaceCatalogPage() {
  const { handle, name } = useParams<{ handle?: string; name?: string }>();
  const { marketplaceRegistry } = useDataSources();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [packages, setPackages] = useState<MarketplacePackageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPackages = useCallback(async (search: string) => {
    try {
      setLoading(true);
      setError(null);
      setPackages(await marketplaceRegistry.listPackages(search));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the Marketplace Registry catalog.');
    } finally {
      setLoading(false);
    }
  }, [marketplaceRegistry]);

  useEffect(() => { void loadPackages(query); }, [loadPackages, query]);

  if (handle && name) {
    return <MarketplacePackageDetail handle={handle} name={name} />;
  }

  return (
    <UIPage width="full">
      <UIPageHeader title="Marketplace catalog" description="Browse public packages published to the Marketplace Registry." />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <Link to="/marketplace">Back to Marketplace</Link>
        <UIInputSearch aria-label="Search Marketplace Registry" placeholder="Search public packages..." value={query} onChange={(event) => setQuery(event.target.value)} allowClear style={{ width: 320 }} />
      </div>
      {loading ? <UISkeleton active avatar lines={5} /> : error ? (
        <UIEmptyState title="Catalog unavailable" description={error} />
      ) : packages.length === 0 ? (
        <UIEmptyState title="No packages found" description={query ? 'Try another search.' : 'The public Registry catalog is empty.'} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {packages.map((pkg) => (
            <UICard key={`${pkg.handle}/${pkg.name}`} hoverable onClick={() => navigate(`/marketplace/catalog/${encodeURIComponent(pkg.handle)}/${encodeURIComponent(pkg.name)}`)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <strong>{pkg.name}</strong><UITag>{pkg.primaryKind}</UITag>
              </div>
              <div style={{ marginTop: 8, color: 'var(--text-secondary)' }}>{pkg.description || 'No description'}</div>
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', color: 'var(--text-tertiary)', fontSize: 12 }}>
                <span>{pkg.fullName}</span><span>v{pkg.version}</span>
              </div>
              <div style={{ marginTop: 12 }}><UIButton size="small" onClick={(event) => { event.stopPropagation(); navigate(`/marketplace/catalog/${encodeURIComponent(pkg.handle)}/${encodeURIComponent(pkg.name)}`); }}>View package</UIButton></div>
            </UICard>
          ))}
        </div>
      )}
    </UIPage>
  );
}

function MarketplacePackageDetail({ handle, name }: { handle: string; name: string }) {
  const { marketplaceRegistry, projectPlugins } = useDataSources();
  const { projectId } = useProjectContext();
  const installPlugin = useInstallProjectPlugin(projectPlugins, projectId);
  const [pkg, setPkg] = useState<MarketplaceRegistryPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setPkg(null);
    setError(null);
    marketplaceRegistry.getPackage(handle, name).then((entry) => {
      if (active) setPkg(entry);
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Could not load this Registry package.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [handle, marketplaceRegistry, name]);

  const onInstall = async () => {
    if (!pkg) return;
    const spec = `${pkg.meta.identity}@${pkg.meta.version}`;
    try {
      setInstalling(true);
      if (pkg.primaryKind === 'adapter') await marketplaceRegistry.installAdapter(spec);
      else if (pkg.primaryKind === 'plugin' && projectId) await installPlugin.mutateAsync(spec);
      else throw new Error('Select a project before installing a plugin.');
      UIMessage.success(`Installed ${pkg.meta.identity}`);
    } catch (err) {
      UIMessage.error(err instanceof Error ? err.message : 'Package installation failed.');
    } finally { setInstalling(false); }
  };

  if (loading) return <UIPage><UISkeleton active avatar lines={5} /></UIPage>;
  if (error || !pkg) return <UIPage><UIEmptyState title="Package unavailable" description={error || 'Registry package not found.'} /><Link to="/marketplace/catalog">Back to catalog</Link></UIPage>;

  return (
    <UIPage width="full">
      <UIPageHeader title={pkg.meta.name} description={pkg.meta.description || 'Marketplace Registry package'} />
      <p><Link to="/marketplace/catalog">Back to catalog</Link></p>
      <UICard>
        <p><strong>Package</strong>: {pkg.authorHandle}/{pkg.name}</p>
        <p><strong>Kind</strong>: {pkg.primaryKind}</p>
        <p><strong>Version</strong>: {pkg.meta.version}</p>
        <p><strong>Canonical identity</strong>: <code>{pkg.meta.identity}</code></p>
        {pkg.meta.permissions?.length ? <p><strong>Permissions</strong>: {pkg.meta.permissions.join(', ')}</p> : null}
        <UIButton variant="primary" loading={installing || installPlugin.isPending} disabled={pkg.primaryKind === 'plugin' && !projectId} onClick={onInstall}>
          Install {pkg.primaryKind}
        </UIButton>
      </UICard>
    </UIPage>
  );
}
