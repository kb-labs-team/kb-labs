import { useNavigate } from 'react-router-dom';
import { UIButton, UIPage, UIPageHeader } from '@kb-labs/studio-ui-kit';
import { InstalledProjectPlugins } from '../components/installed-project-plugins';
import { InstalledPlatformAdapters } from '../components/installed-platform-adapters';

export function PluginsPage() {
  const navigate = useNavigate();

  return (
    <UIPage width="full">
      <UIPageHeader
        title="Marketplace"
        description="Manage installed packages for the selected project."
        actions={(
          <UIButton variant="primary" onClick={() => navigate('/marketplace/catalog')}>
            Open marketplace
          </UIButton>
        )}
      />
      <InstalledProjectPlugins />
      <InstalledPlatformAdapters />
    </UIPage>
  );
}
