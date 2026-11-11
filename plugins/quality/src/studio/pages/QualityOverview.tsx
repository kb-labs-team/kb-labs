import * as React from 'react';
import { UIPage, UIPageHeader, UITabs } from '@kb-labs/sdk/studio';
import { OverviewTab } from '../components/OverviewTab';
import { ArchitectureTab } from '../components/ArchitectureTab';
import { DebtTab } from '../components/DebtTab';
import { HistoryTab } from '../components/HistoryTab';
import { BuildOrderTab } from '../components/BuildOrderTab';

export default function QualityOverview() {
  const tabs = (
    <UITabs
      syncUrl="search"
      items={[
        { key: 'overview', label: 'Overview', children: <OverviewTab /> },
        { key: 'architecture', label: 'Architecture', children: <ArchitectureTab /> },
        { key: 'debt', label: 'Debt', children: <DebtTab /> },
        { key: 'history', label: 'History', children: <HistoryTab /> },
        { key: 'build-order', label: 'Build Order', children: <BuildOrderTab /> },
      ]}
    />
  );

  return (
    <UIPage>
      <UIPageHeader
        title="Quality"
        description="Code health, architecture analysis, and trend tracking"
        tabs={tabs}
      />
    </UIPage>
  );
}
