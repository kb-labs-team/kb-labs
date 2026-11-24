import { UIEmptyState, UISpin, UITable, UITag, type UITableColumn } from '@kb-labs/studio-ui-kit';
import { usePlatformAdapters, type MarketplaceInstalledPackage } from '@kb-labs/studio-data-client';
import { useDataSources } from '@/providers/data-sources-provider';
import { EmptyState } from '@/components/empty-state';

export function InstalledPlatformAdapters() {
  const { marketplaceInventory } = useDataSources();
  const { data: adapters, isLoading, isError, refetch } = usePlatformAdapters(marketplaceInventory);

  const columns: UITableColumn<MarketplaceInstalledPackage>[] = [
    {
      key: 'id',
      title: 'Adapter',
      dataIndex: 'id',
      render: (_value, adapter) => (
        <div>
          <div>{adapter.id}</div>
          <div style={{ opacity: 0.6, fontSize: 12 }}>{adapter.version}</div>
        </div>
      ),
    },
    { key: 'source', title: 'Source', dataIndex: 'source', render: (_value, adapter) => <UITag>{adapter.source}</UITag> },
  ];

  return (
    <section aria-labelledby="installed-adapters-heading" style={{ marginTop: 32 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 id="installed-adapters-heading" style={{ margin: 0, fontSize: 20 }}>Adapters</h2>
        <p style={{ margin: '4px 0 0', opacity: 0.7 }}>Installed at platform scope.</p>
      </div>
      {isLoading ? (
        <UISpin />
      ) : isError ? (
        <EmptyState
          kind="unavailable"
          title="Adapters unavailable"
          description="Installed platform adapters could not be loaded. Try again when the Gateway is available."
          action={{ label: 'Retry', onClick: () => { void refetch(); } }}
        />
      ) : !adapters || adapters.length === 0 ? (
        <UIEmptyState title="No adapters installed" description="Platform adapters installed from the marketplace will appear here." />
      ) : (
        <UITable<MarketplaceInstalledPackage> columns={columns} dataSource={adapters} rowKey="id" pagination={false} />
      )}
    </section>
  );
}
