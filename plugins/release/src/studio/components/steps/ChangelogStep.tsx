/**
 * Step 2: Generate and edit changelog
 */

import * as React from 'react';
import {
  UIButton,
  UICard,
  UIEmptyState,
  UISpin,
  UISpace,
  UIMessage,
  UIInputTextArea,
  UIRow,
  UICol,
  UITypographyText,
  UICheckbox,
  UITag,
  UIIcon,
  UIMarkdownViewer,
} from '@kb-labs/sdk/studio';
import { useData, useMutateData, useTheme } from '@kb-labs/sdk/studio';
import type {
  ChangelogResponse,
  GenerateChangelogRequest,
  GenerateChangelogResponse,
  SaveChangelogRequest,
  SaveChangelogResponse,
} from '../../../contracts/index.js';

interface ChangelogStepProps {
  selectedScope: string;
  onChangelogReady: (ready: boolean) => void;
}

export function ChangelogStep({ selectedScope, onChangelogReady }: ChangelogStepProps) {
  const { antdToken: token } = useTheme();
  const [editMode, setEditMode] = React.useState(true);
  const [markdown, setMarkdown] = React.useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = React.useState(false);
  const [useLLM, setUseLLM] = React.useState(true);

  const changelogUrl = selectedScope ? `/v1/plugins/release/changelog?scope=${encodeURIComponent(selectedScope)}` : '';
  const { data: changelogData, isLoading: changelogLoading } = useData<ChangelogResponse>(changelogUrl);

  const { mutateAsync: generateChangelog, isLoading: generateLoading } = useMutateData<GenerateChangelogRequest, GenerateChangelogResponse>(
    '/v1/plugins/release/changelog/generate',
    'POST',
  );
  const { mutateAsync: saveChangelog, isLoading: saveLoading } = useMutateData<SaveChangelogRequest, SaveChangelogResponse>(
    '/v1/plugins/release/changelog/save',
    'POST',
  );

  React.useEffect(() => {
    if (changelogData?.markdown) {
      setMarkdown(changelogData.markdown);
      setHasUnsavedChanges(false);
    } else {
      setMarkdown('');
      setHasUnsavedChanges(false);
    }
  }, [changelogData]);

  React.useEffect(() => {
    const hasChangelog = !!(markdown && !hasUnsavedChanges);
    onChangelogReady(hasChangelog);
  }, [markdown, hasUnsavedChanges, onChangelogReady]);

  const handleGenerate = async () => {
    try {
      const result = await generateChangelog({ scope: selectedScope, useLLM });
      setMarkdown(result.markdown);
      setHasUnsavedChanges(true);
      const parts: string[] = [];
      if (result.commitsCount) { parts.push(`${result.commitsCount} commits`); }
      if (result.tokensUsed) { parts.push(`${result.tokensUsed} tokens`); }
      const method = result.usedLLM ? 'AI-enhanced' : useLLM ? 'Template' : 'Simple';
      const details = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      UIMessage.success(`${method} changelog generated${details}`);
    } catch (error) {
      UIMessage.error(`Failed to generate changelog: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleSave = async () => {
    try {
      await saveChangelog({ scope: selectedScope, markdown });
      setHasUnsavedChanges(false);
      UIMessage.success('Changelog saved');
    } catch (error) {
      UIMessage.error(`Failed to save: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleMarkdownChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMarkdown(e.target.value);
    setHasUnsavedChanges(true);
  };

  if (changelogLoading) {
    return <UISpin size="large" style={{ display: 'block', margin: '48px auto' }} />;
  }

  if (!changelogData?.markdown && !markdown) {
    return (
      <UICard>
        <UIEmptyState
          description="No changelog generated yet"
          image={UIEmptyState.PRESENTED_IMAGE_SIMPLE}
        >
          <UISpace direction="vertical" size="middle" style={{ display: 'flex', alignItems: 'center' }}>
            <UICheckbox checked={useLLM} onChange={(checked) => setUseLLM(checked)}>
              Use AI-powered generation (requires LLM)
            </UICheckbox>
            <UIButton
              variant="primary"
              icon={<UIIcon name="ThunderboltOutlined" />}
              onClick={() => void handleGenerate()}
              loading={generateLoading}
              size="large"
            >
              Generate Changelog
            </UIButton>
            <UITypographyText type="secondary" style={{ fontSize: 12 }}>
              {useLLM
                ? 'AI will analyze git commits and generate a detailed changelog'
                : 'Generate a simple changelog from package versions'}
            </UITypographyText>
          </UISpace>
        </UIEmptyState>
      </UICard>
    );
  }

  return (
    <UICard
      title={
        <UISpace>
          {hasUnsavedChanges ? (
            <UITag color="warning">Unsaved</UITag>
          ) : (
            <UITag color="success">Saved</UITag>
          )}
          <span>Changelog</span>
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
          <UIButton
            icon={editMode ? <UIIcon name="EyeOutlined" /> : <UIIcon name="EditOutlined" />}
            onClick={() => setEditMode(!editMode)}
            size="small"
          >
            {editMode ? 'Preview' : 'Edit'}
          </UIButton>
          <UIButton
            variant="primary"
            icon={<UIIcon name="SaveOutlined" />}
            onClick={() => void handleSave()}
            loading={saveLoading}
            disabled={!hasUnsavedChanges}
            size="small"
          >
            Save
          </UIButton>
        </UISpace>
      }
    >
      <UIRow gutter={16}>
        <UICol span={editMode ? 12 : 24}>
          {editMode ? (
            <UIInputTextArea
              value={markdown}
              onChange={handleMarkdownChange}
              rows={20}
              style={{ fontFamily: 'monospace', fontSize: 13, height: 450 }}
              placeholder="Write your changelog in Markdown..."
            />
          ) : (
            <div style={{ maxHeight: 500, overflow: 'auto' }}>
              <UIMarkdownViewer content={markdown} />
            </div>
          )}
        </UICol>
        {editMode && (
          <UICol span={12}>
            <div style={{
              border: `1px solid ${token.colorBorder}`,
              borderRadius: token.borderRadius,
              height: 450,
              overflow: 'auto',
              padding: 12,
              background: token.colorFillTertiary,
            }}>
              <UITypographyText type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
                Preview
              </UITypographyText>
              <UIMarkdownViewer content={markdown} />
            </div>
          </UICol>
        )}
      </UIRow>

      {hasUnsavedChanges && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <UITypographyText type="warning" style={{ fontSize: 12 }}>
            Save changelog to proceed to the next step
          </UITypographyText>
        </div>
      )}
    </UICard>
  );
}
