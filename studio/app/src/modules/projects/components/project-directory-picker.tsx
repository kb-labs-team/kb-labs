import * as React from 'react';
import { UIButton, UISpin, UIModal, UIText } from '@kb-labs/studio-ui-kit';
import { useProjectDirectories } from '@kb-labs/studio-data-client';
import { useDataSources } from '@/providers/data-sources-provider';

export function ProjectDirectoryPicker({
  open,
  title,
  onCancel,
  onSelect,
}: {
  open: boolean;
  title: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}) {
  const { projects: source } = useDataSources();
  const [path, setPath] = React.useState<string | undefined>();
  const listing = useProjectDirectories(source, path, open);

  React.useEffect(() => {
    if (!open) setPath(undefined);
  }, [open]);

  return (
    <UIModal
      open={open}
      title={title}
      onCancel={onCancel}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <UIButton disabled={!listing.data?.parentPath} onClick={() => setPath(listing.data?.parentPath ?? undefined)}>
            Up one level
          </UIButton>
          <div style={{ display: 'flex', gap: 8 }}>
            <UIButton onClick={onCancel}>Cancel</UIButton>
            <UIButton
              variant="primary"
              disabled={!listing.data?.currentPath}
              onClick={() => {
                if (listing.data?.currentPath) onSelect(listing.data.currentPath);
              }}
            >
              Choose this folder
            </UIButton>
          </div>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <UIText color="secondary">{listing.data?.currentPath ?? 'Choose a starting folder'}</UIText>
        {listing.isLoading ? <UISpin /> : listing.error ? (
          <UIText color="error">{listing.error.message}</UIText>
        ) : listing.data?.directories.length ? (
          <div aria-label="Folders" style={{ maxHeight: 360, overflow: 'auto', display: 'grid', gap: 4 }}>
            {listing.data.directories.map((directory) => (
              <button
                key={directory.path}
                type="button"
                onClick={() => setPath(directory.path)}
                style={{ textAlign: 'left', padding: '8px 10px', border: '1px solid var(--kb-border-color, #303030)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' }}
              >
                {directory.name}
              </button>
            ))}
          </div>
        ) : (
          <UIText color="secondary">No subfolders here. You can choose this folder.</UIText>
        )}
      </div>
    </UIModal>
  );
}
