/**
 * Session selector component for Agent widget
 */

import React from 'react';
import { useData, UIDropdown, UIButton, UITypographyText, UISpin, UITooltip, UIIcon, useUITheme } from '@kb-labs/sdk/studio';
import type { AgentSessionInfo } from '../../contracts/index.js';

interface SessionSelectorProps {
  currentSessionId: string | null;
  onSessionChange: (sessionId: string, session: AgentSessionInfo) => void;
  onNewChat: () => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) { return 'just now'; }
  if (diffMins < 60) { return `${diffMins}m ago`; }
  if (diffHours < 24) { return `${diffHours}h ago`; }
  if (diffDays < 7) { return `${diffDays}d ago`; }
  return date.toLocaleDateString();
}

export function SessionSelector({
  currentSessionId,
  onSessionChange,
  onNewChat,
}: SessionSelectorProps) {
  const { token } = useUITheme();
  const { data: sessionsData, isLoading } = useData<{ sessions: AgentSessionInfo[]; total: number }>(
    '/v1/plugins/agents/sessions?limit=20',
  );

  const sessions = sessionsData?.sessions ?? [];
  const current = sessions.find((s) => s.id === currentSessionId);
  const label = current ? (current.name || current.task || 'Untitled') : 'New chat';

  const items = isLoading
    ? [{ key: 'loading', label: <UISpin size="small" />, disabled: true }]
    : sessions.length === 0
    ? [{ key: 'empty', label: <UITypographyText type="secondary">No sessions yet</UITypographyText>, disabled: true }]
    : sessions.map((session) => ({
        key: session.id,
        label: (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minWidth: 220 }}>
            <UITypographyText ellipsis style={{ maxWidth: 190 }}>
              {session.name || session.task || 'Untitled'}
            </UITypographyText>
            <UITypographyText type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
              {formatRelativeTime(session.lastActivityAt)}
            </UITypographyText>
          </div>
        ),
        onClick: () => onSessionChange(session.id, session),
      }));

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <UIDropdown menu={{ items }} trigger={['click']} placement="bottomRight">
        <button
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 999,
            background: token.colorBgContainer,
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 13,
            color: token.colorText,
            maxWidth: 220,
          }}
        >
          <UIIcon name="HistoryOutlined" style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <UIIcon name="DownOutlined" style={{ fontSize: 9, color: token.colorTextTertiary, flexShrink: 0 }} />
        </button>
      </UIDropdown>

      <UITooltip title="New chat">
        <UIButton
          shape="circle"
          size="small"
          variant="primary"
          icon={<UIIcon name="PlusOutlined" style={{ fontSize: 12 }} />}
          onClick={onNewChat}
        />
      </UITooltip>
    </div>
  );
}
