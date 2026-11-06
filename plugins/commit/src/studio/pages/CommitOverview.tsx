/**
 * CommitOverview — main commit plugin page.
 * Scope selector + tabbed view (Plan / Files).
 */

import { useState, useEffect } from 'react';
import { useData, UIPage, UIPageHeader, UITabs, UISelect, type SelectData } from '@kb-labs/sdk/studio';
import { CommitPlanTab } from '../components/CommitPlanTab';
import { CommitFilesTab } from '../components/CommitFilesTab';

export default function CommitOverview() {
  const [scope, setScope] = useState<string>('');

  const { data: scopesData, isLoading: scopesLoading } = useData<SelectData>(
    '/v1/plugins/commit/scopes',
  );

  // Auto-select first scope
  useEffect(() => {
    if (scopesData?.options?.length && !scope) {
      setScope(scopesData.value || scopesData.options[0]!.value);
    }
  }, [scopesData, scope]);

  const scopeOptions = scopesData?.options?.map((s) => ({
    label: s.label,
    value: s.value,
  })) ?? [];

  const tabs = (
    <UITabs
      syncUrl="search"
      items={[
        {
          key: 'plan',
          label: 'Commit Plan',
          children: <CommitPlanTab scope={scope} />,
        },
        {
          key: 'files',
          label: 'Files',
          children: <CommitFilesTab scope={scope} />,
        },
      ]}
    />
  );

  const showScopeSelect = scopeOptions.length > 1;

  return (
    <UIPage>
      <UIPageHeader
        title="Commit"
        description="AI-powered commit generation"
        actions={
          showScopeSelect ? (
            <UISelect
              style={{ width: 260 }}
              placeholder="Select repository..."
              value={scope || undefined}
              onChange={(v) => setScope(v as string)}
              loading={scopesLoading}
              showSearch
              options={scopeOptions}
            />
          ) : undefined
        }
        tabs={tabs}
      />
    </UIPage>
  );
}
