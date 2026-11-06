/**
 * Release Manager main page with scope-based workflow
 */

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { UIPage, UIPageHeader, UITabs, UISelect, UIAccordion, UIDescriptions, UIDescriptionsItem, UITag, useData } from '@kb-labs/sdk/studio';
import { ReleaseStepper } from '../components/ReleaseStepper';
import { HistoryTab } from '../components/HistoryTab';
import { OverviewTab } from '../components/OverviewTab';
import type { ScopesResponse } from '../../contracts/index.js';

const DEFAULT_TAB = 'overview';

function ReleasePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedScope = searchParams.get('scope') ?? '';
  const activeTab = searchParams.get('tab') ?? DEFAULT_TAB;

  const setSelectedScope = (scope: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('scope', scope);
      next.delete('step');
      return next;
    });
  };

  // UITabs' own syncUrl="search" mode replaces the whole query string on
  // change, dropping ?scope= (and ?step=) along with it — driving it in
  // controlled mode here instead so tab switches merge into the existing
  // params rather than clobbering them.
  const setActiveTab = (tab: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === DEFAULT_TAB) {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      return next;
    });
  };

  const goToFlow = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'flow');
      next.delete('step');
      return next;
    });
  };

  const goToHistory = () => setActiveTab('history');

  const { data: scopesData, isLoading: scopesLoading } = useData<ScopesResponse>('/v1/plugins/release/scopes');

  React.useEffect(() => {
    if (scopesData?.scopes && scopesData.scopes.length > 0 && !selectedScope) {
      const rootScope = scopesData.scopes.find((s) => s.id === 'root');
      const firstScope = scopesData.scopes[0];
      setSelectedScope(rootScope?.id ?? firstScope?.id ?? '');
    }
  }, [scopesData]);

  const currentScope = scopesData?.scopes?.find((s) => s.id === selectedScope);

  const getTypeColor = (type?: string) => {
    switch (type) {
      case 'monorepo': return 'blue';
      case 'package': return 'green';
      case 'root': return 'purple';
      default: return 'default';
    }
  };

  const tabs = (
    <UITabs
      activeKey={activeTab}
      onChange={setActiveTab}
      items={[
        {
          key: 'overview',
          label: 'Overview',
          children: (
            <OverviewTab
              scope={currentScope}
              selectedScope={selectedScope}
              onStartRelease={goToFlow}
              onViewHistory={goToHistory}
            />
          ),
        },
        {
          key: 'flow',
          label: 'Release Flow',
          children: (
            <>
              {currentScope && (
                <UIAccordion
                  size="small"
                  style={{ marginBottom: 16 }}
                  items={[
                    {
                      key: 'scope-info',
                      label: currentScope.currentVersion
                        ? `${currentScope.name} v${currentScope.currentVersion}`
                        : currentScope.name,
                      extra: <UITag color={getTypeColor(currentScope.type)}>{currentScope.type}</UITag>,
                      children: (
                        <UIDescriptions size="small" column={1} bordered>
                          <UIDescriptionsItem label="Package Name">{currentScope.id}</UIDescriptionsItem>
                          {currentScope.currentVersion && (
                            <UIDescriptionsItem label="Current Version">{currentScope.currentVersion}</UIDescriptionsItem>
                          )}
                          {currentScope.description && (
                            <UIDescriptionsItem label="Description">{currentScope.description}</UIDescriptionsItem>
                          )}
                          <UIDescriptionsItem label="Path">
                            <code style={{ fontSize: 12 }}>{currentScope.path}</code>
                          </UIDescriptionsItem>
                          <UIDescriptionsItem label="Type">
                            <UITag color={getTypeColor(currentScope.type)}>{currentScope.type}</UITag>
                          </UIDescriptionsItem>
                        </UIDescriptions>
                      ),
                    },
                  ]}
                />
              )}
              <ReleaseStepper selectedScope={selectedScope} selectedScopePath={currentScope?.path} />
            </>
          ),
        },
        {
          key: 'history',
          label: 'History',
          children: <HistoryTab selectedScope={selectedScope} />,
        },
      ]}
    />
  );

  return (
    <UIPage>
      <UIPageHeader
        title="Release Manager"
        description="Plan, execute, and audit releases across your workspace"
        actions={
          <UISelect
            style={{ width: 400 }}
            placeholder="Select scope (package or monorepo)"
            value={selectedScope || undefined}
            onChange={(v) => setSelectedScope(v as string)}
            loading={scopesLoading}
            showSearch
            optionFilterProp="label"
            options={scopesData?.scopes?.map((s) => ({
              label: `${s.name} (${s.type})`,
              value: s.id,
            })) ?? []}
          />
        }
        tabs={tabs}
      />
    </UIPage>
  );
}
export default ReleasePage;
