/**
 * Step 1: Generate and review release plan
 */

import * as React from 'react';
import {
  UIButton,
  UICard,
  UIEmptyState,
  UISpin,
  UITable,
  UITypographyText,
  UISpace,
  UITag,
  UIMessage,
  UICheckbox,
  UIAccordion,
  UITimeline,
  UIIcon,
  UIAlert,
} from '@kb-labs/sdk/studio';
import { useData, useMutateData } from '@kb-labs/sdk/studio';
import type {
  StatusResponse,
  PlanResponse,
  GitTimelineResponse,
  GeneratePlanRequest,
  GeneratePlanResponse,
} from '../../../contracts/index.js';

interface PlanStepProps {
  selectedScope: string;
  selectedScopePath?: string;
  onPlanReady: (ready: boolean) => void;
}

const INITIAL_COMMITS_COUNT = 5;

export function PlanStep({ selectedScope, selectedScopePath, onPlanReady }: PlanStepProps) {
  const [useLLM, setUseLLM] = React.useState(true);
  const [showAllCommits, setShowAllCommits] = React.useState(false);

  const statusUrl = selectedScope ? `/v1/plugins/release/status?scope=${encodeURIComponent(selectedScope)}` : '';
  const planUrl = selectedScope ? `/v1/plugins/release/plan?scope=${encodeURIComponent(selectedScope)}` : '';
  const timelineUrl = selectedScope ? `/v1/plugins/release/git-timeline?scope=${encodeURIComponent(selectedScope)}` : '';

  const { data: statusData, isLoading: statusLoading, refetch: refetchStatus } = useData<StatusResponse>(statusUrl);
  const { data: planData, isLoading: planLoading, refetch: refetchPlan } = useData<PlanResponse>(planUrl);
  const { data: gitTimelineData } = useData<GitTimelineResponse>(timelineUrl);

  const { mutateAsync: generatePlan, isLoading: generateLoading } = useMutateData<GeneratePlanRequest, GeneratePlanResponse>(
    '/v1/plugins/release/generate',
    'POST',
  );

  React.useEffect(() => {
    const hasPlan = !!(planData?.plan && planData.plan.packages.length > 0);
    onPlanReady(hasPlan);
  }, [planData, onPlanReady]);

  const handleGenerate = async () => {
    try {
      const result = await generatePlan({ scope: selectedScope, scopePath: selectedScopePath, useLLM });
      refetchStatus();
      refetchPlan();
      const confidencePercent = result.confidence ? Math.round(result.confidence * 100) : 0;
      const tokensInfo = result.tokensUsed ? `, ${result.tokensUsed} tokens` : '';
      const method = useLLM ? 'AI-powered' : 'Simple';
      UIMessage.success(`${method} plan generated (${confidencePercent}% confidence${tokensInfo})`);
    } catch (error) {
      UIMessage.error(`Failed to generate plan: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  if (statusLoading) {
    return <UISpin size="large" style={{ display: 'block', margin: '48px auto' }} />;
  }

  if (!statusData?.hasPlan && !planData?.plan) {
    const noChanges = gitTimelineData !== undefined && !gitTimelineData.hasUnreleasedChanges;
    if (noChanges) {
      return (
        <UICard>
          <UIEmptyState
            description={`No unreleased changes since ${gitTimelineData?.lastTag ?? 'last release'}`}
            image={UIEmptyState.PRESENTED_IMAGE_SIMPLE}
          />
        </UICard>
      );
    }
    return (
      <UICard>
        <UIEmptyState
          description="No release plan generated yet"
          image={UIEmptyState.PRESENTED_IMAGE_SIMPLE}
        >
          <UISpace direction="vertical" size="middle" style={{ display: 'flex', alignItems: 'center' }}>
            <UICheckbox checked={useLLM} onChange={(checked) => setUseLLM(checked)}>
              Use AI-powered analysis (requires LLM)
            </UICheckbox>
            <UIButton
              variant="primary"
              icon={<UIIcon name="ThunderboltOutlined" />}
              onClick={() => void handleGenerate()}
              loading={generateLoading}
              size="large"
            >
              Generate Release Plan
            </UIButton>
            <UITypographyText type="secondary" style={{ fontSize: 12 }}>
              {useLLM
                ? 'AI will analyze git history and provide intelligent reasoning for version bumps'
                : 'Generate plan using conventional commits analysis'}
            </UITypographyText>
          </UISpace>
        </UIEmptyState>
      </UICard>
    );
  }

  if (planLoading || !planData?.plan) {
    return <UISpin size="large" style={{ display: 'block', margin: '48px auto' }} />;
  }

  const { plan } = planData;

  if (plan.packages.length === 0) {
    return (
      <UICard>
        <UIEmptyState
          description="Plan exists but contains no packages"
          image={UIEmptyState.PRESENTED_IMAGE_SIMPLE}
        >
          <UISpace direction="vertical" size="middle" style={{ display: 'flex', alignItems: 'center' }}>
            <UITypographyText type="secondary" style={{ fontSize: 12 }}>
              This may happen if there are no changes to release or the scope has no packages.
            </UITypographyText>
            <UICheckbox checked={useLLM} onChange={(checked) => setUseLLM(checked)}>
              Use AI-powered analysis
            </UICheckbox>
            <UIButton
              variant="primary"
              icon={<UIIcon name="ThunderboltOutlined" />}
              onClick={() => void handleGenerate()}
              loading={generateLoading}
            >
              Regenerate Plan
            </UIButton>
          </UISpace>
        </UIEmptyState>
      </UICard>
    );
  }

  const columns = [
    {
      title: 'Package',
      dataIndex: 'name',
      key: 'name',
      width: 280,
      ellipsis: true,
      render: (name: string) => (
        <UITypographyText strong ellipsis={{ tooltip: name }}>{name}</UITypographyText>
      ),
    },
    {
      title: 'Current',
      dataIndex: 'currentVersion',
      key: 'currentVersion',
      width: 180,
      ellipsis: true,
      render: (version: string) => version ? (
        <UITag color="blue" title={version} style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {version}
        </UITag>
      ) : '-',
    },
    {
      title: 'Next',
      dataIndex: 'nextVersion',
      key: 'nextVersion',
      width: 180,
      ellipsis: true,
      render: (version: string) => version ? (
        <UITag color="green" title={version} style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {version}
        </UITag>
      ) : '-',
    },
    {
      title: 'Bump',
      dataIndex: 'bump',
      key: 'bump',
      width: 80,
      render: (bump: string) => {
        if (!bump) { return '-'; }
        const colorMap: Record<string, string> = { major: 'red', minor: 'orange', patch: 'blue' };
        return <UITag color={colorMap[bump] || 'default'}>{bump}</UITag>;
      },
    },
    {
      title: 'Reason',
      dataIndex: 'reason',
      key: 'reason',
      ellipsis: true,
      render: (reason: string) => (
        <UITypographyText type="secondary" style={{ fontSize: 12 }}>{reason || '-'}</UITypographyText>
      ),
    },
  ];

  return (
    <UICard
      title={
        <UISpace>
          <UIIcon name="CheckCircleOutlined" style={{ color: '#52c41a' }} />
          <span>Release Plan Ready</span>
          <UITag color="blue">{plan.packages.length} package(s)</UITag>
        </UISpace>
      }
      extra={
        <UISpace>
          <UICheckbox checked={useLLM} onChange={(checked) => setUseLLM(checked)}>Use AI</UICheckbox>
          <UIButton
            icon={<UIIcon name="ThunderboltOutlined" />}
            onClick={() => void handleGenerate()}
            loading={generateLoading}
            size="small"
          >
            Regenerate
          </UIButton>
        </UISpace>
      }
    >
      {gitTimelineData?.hasUnreleasedChanges && (
        <UIAccordion
          size="small"
          style={{ marginBottom: 16 }}
          defaultActiveKey={['timeline']}
          items={[
            {
              key: 'timeline',
              label: 'Git Timeline',
              extra: <UISpace><UITag>{gitTimelineData.unreleased} commits</UITag></UISpace>,
              children: (
                <>
                  {gitTimelineData.suggestedVersion && (
                    <UIAlert
                      variant="success"
                      style={{ marginBottom: 16 }}
                      message={
                        <UISpace>
                          <UITypographyText strong>
                            {gitTimelineData.currentVersion || '0.0.0'} → {gitTimelineData.suggestedVersion}
                          </UITypographyText>
                          <UITag color={
                            gitTimelineData.suggestedBump === 'major' ? 'red' :
                            gitTimelineData.suggestedBump === 'minor' ? 'orange' : 'blue'
                          }>
                            {gitTimelineData.suggestedBump}
                          </UITag>
                        </UISpace>
                      }
                    />
                  )}
                  <UITimeline
                    mode="left"
                    items={(gitTimelineData.commits ?? [])
                      .slice(0, showAllCommits ? undefined : INITIAL_COMMITS_COUNT)
                      .map((commit: { type: string; shortSha: string; message: string }) => ({
                        color: commit.type === 'feat' ? 'green' : commit.type === 'fix' ? 'red' : commit.type === 'BREAKING' ? 'volcano' : 'gray',
                        children: (
                          <div>
                            <UISpace size="small">
                              <UITag color={commit.type === 'feat' ? 'green' : commit.type === 'fix' ? 'red' : commit.type === 'BREAKING' ? 'volcano' : 'default'} style={{ fontSize: 10 }}>
                                {commit.type}
                              </UITag>
                              <UITypographyText code style={{ fontSize: 10 }}>{commit.shortSha}</UITypographyText>
                            </UISpace>
                            <div style={{ marginTop: 2 }}>
                              <UITypographyText style={{ fontSize: 12 }}>{commit.message}</UITypographyText>
                            </div>
                          </div>
                        ),
                      }))}
                  />
                  {(gitTimelineData.commits?.length ?? 0) > INITIAL_COMMITS_COUNT && (
                    <UIButton
                      variant="link"
                      size="small"
                      icon={showAllCommits ? <UIIcon name="UpOutlined" /> : <UIIcon name="DownOutlined" />}
                      onClick={() => setShowAllCommits(!showAllCommits)}
                      style={{ padding: 0 }}
                    >
                      {showAllCommits ? 'Show less' : `Show ${(gitTimelineData.commits?.length ?? 0) - INITIAL_COMMITS_COUNT} more`}
                    </UIButton>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      <UITable
        columns={columns}
        dataSource={plan.packages}
        rowKey="name"
        pagination={false}
        size="small"
        scroll={{ x: 'max-content' }}
      />
    </UICard>
  );
}
