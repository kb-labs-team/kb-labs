import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useData, useMutateData, useWebSocket,
  UIInputTextArea, UIButton, UIMessage,
  UISegmented, UISwitch, UIPopover, UITypographyText, UIIcon, useUITheme,
  UIImagePreview, UIImagePreviewGroup,
} from '@kb-labs/sdk/studio';
import type { WebSocketStatus } from '@kb-labs/sdk/studio';
import type { AgentAttachmentUpload, RunRequest } from '@kb-labs/agent-contracts';
import { SessionSelector } from '../components/SessionSelector';
import { ConversationView, type AgentImagePreview } from '../components/ConversationView';
import {
  createInitialState, loadProjection, setTurn, advanceSeq, applyDelta, reconcileOptimistic,
  type TurnReducerState,
} from '../turn-reducer';
import type { AgentSessionInfo, Turn, AgentResponseMode, RunStatusResponse, ServerMessage } from '@kb-labs/agent-contracts';

type RunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';

interface AttachmentDraft extends AgentAttachmentUpload {
  sizeBytes: number;
}

const ATTACHMENT_LIMIT = 7 * 1024 * 1024;
const TOTAL_ATTACHMENT_LIMIT = 7 * 1024 * 1024;
const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read file'));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

interface RunResponse {
  runId: string;
  sessionId: string;
  userTurn: Turn;
}

interface StopRequest {
  reason?: string;
}

function compareTurns(a: Turn, b: Turn): number {
  if (a.sequence !== b.sequence) { return a.sequence - b.sequence; }
  if (a.type !== b.type) {
    if (a.type === 'user') { return -1; }
    if (b.type === 'user') { return 1; }
  }
  return a.startedAt.localeCompare(b.startedAt);
}

function buildAgentWsUrl(sessionId: string, afterSeq?: number | null): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const base = `${protocol}//${host}/api/v1/ws/plugins/agents/session/${sessionId}`;
  return afterSeq != null ? `${base}?afterSeq=${afterSeq}` : base;
}

// ---------- ConnectionBadge ----------

function ConnectionBadge({
  status,
  sessionId,
  onReconnect,
}: {
  status: WebSocketStatus;
  sessionId: string | null;
  onReconnect: () => void;
}) {
  const { token } = useUITheme();
  if (!sessionId) { return null; }
  if (status === 'connected') { return null; }

  if (status === 'connecting') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <UIIcon name="LoadingOutlined" style={{ fontSize: 12, color: token.colorTextTertiary }} />
        <UITypographyText type="secondary" style={{ fontSize: 12 }}>Connecting...</UITypographyText>
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <UIIcon name="DisconnectOutlined" style={{ fontSize: 12, color: token.colorError }} />
      <UIButton
        variant="link"
        size="small"
        style={{ padding: 0, fontSize: 12, height: 'auto' }}
        onClick={onReconnect}
      >
        Reconnect
      </UIButton>
    </span>
  );
}

// ---------- ComposerSettings ----------

function ComposerSettings({
  responseMode,
  setResponseMode,
  tier,
  setTier,
  enableEscalation,
  setEnableEscalation,
  disabled,
  token,
}: {
  responseMode: AgentResponseMode;
  setResponseMode: (v: AgentResponseMode) => void;
  tier: 'small' | 'medium' | 'large';
  setTier: (v: 'small' | 'medium' | 'large') => void;
  enableEscalation: boolean;
  setEnableEscalation: (v: boolean) => void;
  disabled: boolean;
  token: ReturnType<typeof useUITheme>['token'];
}) {
  return (
    <div style={{ width: 220, display: 'flex', flexDirection: 'column', gap: 14, padding: 4 }}>
      <div>
        <UITypographyText type="secondary" style={{ fontSize: 11, fontWeight: 500 }}>RESPONSE</UITypographyText>
        <UISegmented
          block
          size="small"
          value={responseMode}
          onChange={(v) => setResponseMode(v as AgentResponseMode)}
          disabled={disabled}
          style={{ marginTop: 6 }}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'brief', label: 'Brief' },
            { value: 'deep', label: 'Deep' },
          ]}
        />
      </div>
      <div>
        <UITypographyText type="secondary" style={{ fontSize: 11, fontWeight: 500 }}>MODEL TIER</UITypographyText>
        <UISegmented
          block
          size="small"
          value={tier}
          onChange={(v) => setTier(v as 'small' | 'medium' | 'large')}
          disabled={disabled}
          style={{ marginTop: 6 }}
          options={[
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <UITypographyText style={{ fontSize: 13 }}>Auto escalate</UITypographyText>
        <UISwitch
          checked={enableEscalation}
          onChange={setEnableEscalation}
          disabled={disabled || tier === 'large'}
          size="small"
        />
      </div>
      <UITypographyText type="secondary" style={{ fontSize: 11, borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 8 }}>
        Escalates to a larger model when the task needs it.
      </UITypographyText>
    </div>
  );
}

function tierLabel(tier: 'small' | 'medium' | 'large'): string {
  return tier === 'small' ? 'Small' : tier === 'large' ? 'Large' : 'Medium';
}

// ---------- AgentsPage ----------

function AgentsPage() {
  const { token } = useUITheme();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const runStartedAtRef = useRef<string | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    () => searchParams.get('session'),
  );
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(
    () => searchParams.get('session'),
  );

  const [task, setTask] = useState('');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  // The server intentionally keeps only safe attachment metadata on turns.
  // Browser-local IndexedDB backs the preview so message history can restore it
  // after navigation/reload without putting raw file bytes on the server.
  const [attachmentPreviews, setAttachmentPreviews] = useState<Map<string, AgentImagePreview[]>>(new Map());
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  // Optimistic user turns, keyed by the client-generated clientId that the
  // server echoes back on the real turn — reconciled by id, not by fuzzy
  // text-matching (which could misfire on duplicate/similar messages).
  const [optimisticTurns, setOptimisticTurns] = useState<Map<string, Turn>>(new Map());
  const [reducerState, setReducerState] = useState<TurnReducerState>(createInitialState());
  // Whether conversation:snapshot has been received for the CURRENT session —
  // gates whether we still show the REST-fetched history (pre-WS-connect) or
  // the reducer's live projection. There is no merge between the two: once
  // the snapshot lands, it's authoritative and REST data is never consulted again.
  const [hasSnapshot, setHasSnapshot] = useState(false);
  // Set when the reducer detects a seq gap (a delta arrived skipping ahead of
  // lastSeq+1 — e.g. a missed WS message). Changing this changes wsUrl, which
  // useWebSocket treats as a URL change and reconnects automatically; the
  // fresh connection's conversation:snapshot then reloads the full projection,
  // recovering from whatever was missed. Reset back to null once that snapshot lands.
  const [resumeAfterSeq, setResumeAfterSeq] = useState<number | null>(null);
  const [responseMode, setResponseMode] = useState<AgentResponseMode>('auto');
  const [tier, setTier] = useState<'small' | 'medium' | 'large'>('medium');
  const [enableEscalation, setEnableEscalation] = useState(true);
  const [agentMode, setAgentMode] = useState<'execute' | 'plan'>('execute');
  const [inputFocused, setInputFocused] = useState(false);

  const agentId = 'mind-assistant';
  const wsUrl = currentSessionId ? buildAgentWsUrl(currentSessionId, resumeAfterSeq) : null;

  const startRunMutation = useMutateData<RunRequest, RunResponse>('/v1/plugins/agents/run', 'POST');
  const {
    data: polledRunStatus,
  } = useData<RunStatusResponse>(
    currentRunId ? `/v1/plugins/agents/run/${currentRunId}` : '',
    { enabled: !!currentRunId && runStatus === 'running', pollingMs: 1000 },
  );
  const stopMutation = useMutateData<StopRequest, unknown>(
    currentRunId ? `/v1/plugins/agents/run/${currentRunId}/stop` : '/v1/plugins/agents/run/noop/stop',
    'POST',
  );

  const sessionTurnsUrl = currentSessionId ? `/v1/plugins/agents/sessions/${currentSessionId}/turns` : '';
  const {
    data: sessionTurnsData,
    isFetching: turnsFetching,
    isError: turnsError,
    refetch: refetchTurns,
  } = useData<{ turns: Turn[]; total: number }>(sessionTurnsUrl, { enabled: !!currentSessionId });

  // The run can fail or finish before the browser opens its session WebSocket.
  // In that case the terminal `run:completed` event is missed, so reconcile
  // through the existing status endpoint while a run is marked as running.
  useEffect(() => {
    if (!polledRunStatus || polledRunStatus.status === 'pending' || polledRunStatus.status === 'running') {
      return;
    }
    setRunStatus(polledRunStatus.status);
    runStartedAtRef.current = null;
  }, [polledRunStatus]);

  useEffect(() => {
    if (currentSessionId && (sessionTurnsData || turnsError) && !turnsFetching) {
      setLoadedSessionId(currentSessionId);
    }
  }, [currentSessionId, sessionTurnsData, turnsError, turnsFetching]);

  const ws = useWebSocket<unknown, ServerMessage>(wsUrl, {
    reconnect: true,
    maxReconnects: 10,
    reconnectIntervalMs: 2000,
    onMessage: (data) => {
      switch (data.type) {
        case 'conversation:snapshot': {
          const { completedTurns, activeTurns, seq } = data.payload;
          const allTurns = [...completedTurns, ...activeTurns];
          setReducerState(loadProjection(allTurns, seq));
          setHasSnapshot(true);
          // Whatever gap prompted this reconnect (if any) is now resolved —
          // clear it so future reconnects go through the normal cold-connect
          // path instead of resending a now-stale afterSeq query param.
          setResumeAfterSeq(null);
          // A reconnect (or a second tab) may deliver a snapshot that already
          // contains a turn this tab sent optimistically — drop it by clientId.
          setOptimisticTurns((prev) => reconcileOptimistic(prev, allTurns));
          break;
        }
        case 'turn:delta': {
          const { delta } = data.payload;
          setReducerState((prev) => {
            const result = applyDelta(prev, delta);
            if (result.status === 'gap') {
              // Missed at least one delta (seq skipped ahead of lastSeq+1) —
              // force a reconnect so the fresh conversation:snapshot recovers
              // whatever was missed. Uses the seq we knew about BEFORE this
              // delta, not the delta's own seq, so the server can tell (from
              // its logs) exactly which range was skipped.
              setResumeAfterSeq(prev.lastSeq);
            }
            return result.state;
          });
          break;
        }
        case 'session:cursor': {
          setReducerState((prev) => advanceSeq(prev, data.payload.seq));
          break;
        }
        case 'run:completed': {
          const { success, summary, seq, turn } = data.payload;
          setRunStatus(success ? 'completed' : 'failed');
          runStartedAtRef.current = null;
          setReducerState((prev) => advanceSeq(turn ? setTurn(prev, turn) : prev, seq));
          console.log('[AgentsPage] Run completed:', summary);
          break;
        }
        case 'error': {
          const { code, message } = data.payload;
          UIMessage.error(`Agent error [${code}]: ${message}`);
          break;
        }
      }
    },
  });

  // Auto-scroll to bottom on new turns
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [reducerState.turnsById.size, optimisticTurns.size]);

  const handleSessionChange = useCallback((sessionId: string, _session: AgentSessionInfo) => {
    setCurrentSessionId(sessionId);
    setLoadedSessionId(null);
    setSearchParams({ session: sessionId }, { replace: true });
    setCurrentRunId(null);
    setRunStatus('idle');
    runStartedAtRef.current = null;
    setOptimisticTurns(new Map());
    setAttachmentPreviews(new Map());
    setReducerState(createInitialState());
    setHasSnapshot(false);
    setResumeAfterSeq(null);
    ws.clear();
  }, [ws, setSearchParams]);

  const handleNewChat = useCallback(() => {
    setCurrentSessionId(null);
    setLoadedSessionId(null);
    setSearchParams({}, { replace: true });
    setCurrentRunId(null);
    setRunStatus('idle');
    runStartedAtRef.current = null;
    setOptimisticTurns(new Map());
    setAttachmentPreviews(new Map());
    setReducerState(createInitialState());
    setHasSnapshot(false);
    setResumeAfterSeq(null);
    ws.clear();
  }, [ws, setSearchParams]);

  const handleStart = useCallback(async () => {
    if (!task.trim()) { return; }

    const userMessage = task.trim();
    runStartedAtRef.current = new Date().toISOString();
    const selectedAttachments = attachments;
    setTask('');
    setCurrentRunId(null);
    setRunStatus('running');

    const clientId = crypto.randomUUID();
    const imageAttachments = selectedAttachments.filter((attachment) => attachment.mediaType.startsWith('image/'));
    if (imageAttachments.length > 0) {
      setAttachmentPreviews((previous) => {
        const next = new Map(previous);
        next.set(clientId, imageAttachments.map(({ name, mediaType, data }) => ({ name, mediaType, data })));
        return next;
      });
    }
    const optimisticTurn: Turn = {
      id: `optimistic-${clientId}`,
      type: 'user',
      sequence: Number.MAX_SAFE_INTEGER,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'completed',
      steps: [{ type: 'text', id: 'opt-1', timestamp: new Date().toISOString(), content: userMessage, role: 'user' }],
      metadata: {
        agentId: 'user',
        clientId,
        attachments: selectedAttachments.map(({ name, mediaType, sizeBytes }) => ({ name, mediaType, sizeBytes })),
      },
    };
    setOptimisticTurns((prev) => new Map(prev).set(clientId, optimisticTurn));

    try {
      const response = await startRunMutation.mutateAsync({
        task: userMessage,
        attachments: selectedAttachments.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
        agentId,
        sessionId: currentSessionId ?? undefined,
        tier,
        enableEscalation,
        responseMode,
        mode: agentMode,
        clientId,
      });

      if (!currentSessionId) {
        setCurrentSessionId(response.sessionId);
        setLoadedSessionId(response.sessionId);
        setSearchParams({ session: response.sessionId }, { replace: true });
      }

      setCurrentRunId(response.runId);
      setAttachments((current) => current === selectedAttachments ? [] : current);

      // The real user turn is already known from the REST response — reconcile
      // immediately by id, no need to wait on a WS round-trip. User turns never
      // get a turn:delta (createUserTurn writes directly to turns.json, outside
      // the event log the delta pipeline is derived from), so this is the only
      // reconciliation path for them.
      setReducerState((prev) => setTurn(prev, response.userTurn));
      setOptimisticTurns((prev) => {
        const next = new Map(prev);
        next.delete(clientId);
        return next;
      });
    } catch (error) {
      setAttachmentPreviews((previous) => {
        if (!previous.has(clientId)) { return previous; }
        const next = new Map(previous);
        next.delete(clientId);
        return next;
      });
      setOptimisticTurns((prev) => {
        const next = new Map(prev);
        next.delete(clientId);
        return next;
      });
      setRunStatus('failed');
      runStartedAtRef.current = null;
      UIMessage.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [
    task, agentId, currentSessionId, tier, enableEscalation,
    responseMode, agentMode, attachments, setSearchParams, startRunMutation,
  ]);

  const handleAttachmentFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList?.length) { return; }
    try {
      const next: AttachmentDraft[] = [];
      let total = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
      for (const file of Array.from(fileList)) {
        const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        const mediaType = Object.values(ATTACHMENT_MEDIA_TYPES).includes(file.type)
          ? file.type
          : ATTACHMENT_MEDIA_TYPES[extension];
        if (!mediaType || !Object.values(ATTACHMENT_MEDIA_TYPES).includes(mediaType)) {
          throw new Error(`${file.name}: supported formats are PDF, JPEG, PNG, WebP and GIF.`);
        }
        if (file.size === 0 || file.size > ATTACHMENT_LIMIT) {
          throw new Error(`${file.name}: each attachment must be between 1 byte and 7 MiB.`);
        }
        total += file.size;
        if (total > TOTAL_ATTACHMENT_LIMIT || attachments.length + next.length >= 10) {
          throw new Error('A run can include up to 10 attachments with a combined size of 7 MiB.');
        }
        const dataUrl = await readFileAsDataUrl(file);
        next.push({
          name: file.name,
          mediaType,
          data: dataUrl.slice(dataUrl.indexOf(',') + 1),
          sizeBytes: file.size,
        });
      }
      setAttachments((current) => [...current, ...next]);
    } catch (error) {
      UIMessage.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (attachmentInputRef.current) { attachmentInputRef.current.value = ''; }
    }
  }, [attachments]);

  const handleStop = useCallback(async () => {
    if (!currentRunId) { return; }
    try {
      await stopMutation.mutateAsync({ reason: 'Stopped by user' });
      setRunStatus('stopped');
      runStartedAtRef.current = null;
      UIMessage.info('Stopped');
    } catch (error) {
      UIMessage.error(`Failed to stop: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [currentRunId, stopMutation]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && runStatus !== 'running' && !startRunMutation.isLoading) {
      e.preventDefault();
      void handleStart();
    }
  };

  const isRunning = runStatus === 'running' || startRunMutation.isLoading;
  const isSwitchingSession = currentSessionId !== null && currentSessionId !== loadedSessionId;

  const turns = (() => {
    if (isSwitchingSession) { return []; }

    // No merge, no LWW: before the WS snapshot arrives, show REST history;
    // once it lands, the reducer's projection is authoritative and alone —
    // REST data is never consulted again for this session.
    const base: Turn[] = hasSnapshot
      ? [...reducerState.turnsById.values()]
      : (sessionTurnsData?.turns ?? []);

    return [...base, ...optimisticTurns.values()].sort(compareTurns);
  })();

  const turnsWithThinkingLoader: Turn[] = (() => {
    if (!isRunning) { return turns; }

    const hasActiveAssistant = turns.some((t) => t.type === 'assistant' && t.status === 'streaming');
    if (hasActiveAssistant) { return turns; }

    const lastUserTurn = [...turns].reverse().find((t) => t.type === 'user');
    if (!lastUserTurn) { return turns; }

    const hasCompletedAssistantAfterUser = turns.some(
      (t) => t.type === 'assistant' && t.status === 'completed' && t.sequence > lastUserTurn.sequence,
    );
    if (hasCompletedAssistantAfterUser) { return turns; }

    const loaderTurn: Turn = {
      id: `thinking-loader-${lastUserTurn.id}`,
      type: 'assistant',
      sequence: lastUserTurn.sequence + 0.1,
      startedAt: runStartedAtRef.current ?? new Date().toISOString(),
      completedAt: null,
      status: 'streaming',
      steps: [],
      metadata: { agentId: 'assistant-loader' },
    };

    return [...turns, loaderTurn].sort(compareTurns);
  })();

  const hasDisconnectedActiveRun = runStatus === 'running' && !!currentRunId && !ws.isConnected;

  const isLoading = isSwitchingSession || (turnsFetching && turns.length === 0 && !!currentSessionId);
  const canSend = !!task.trim() && !startRunMutation.isLoading;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 28, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: token.colorBgContainer }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <UIIcon name="RobotOutlined" style={{ fontSize: 15, color: token.colorTextSecondary }} />
          <UITypographyText strong style={{ fontSize: 14 }}>Agent</UITypographyText>
        </div>
        <SessionSelector
          currentSessionId={currentSessionId}
          onSessionChange={handleSessionChange}
          onNewChat={handleNewChat}
        />
      </div>

      {/* Conversation */}
      <div ref={scrollContainerRef} style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', width: '100%' }}>
          {hasDisconnectedActiveRun && (
            <div role="status" style={{ padding: '6px 20px', color: token.colorWarningText, background: token.colorWarningBg, fontSize: 12 }}>
              Connection to the agent was lost. Reconnecting… The run may still be active.
            </div>
          )}
          <ConversationView
            turns={turnsWithThinkingLoader}
            isLoading={isLoading}
            isError={turnsError}
            onRetry={() => void refetchTurns()}
            sessionId={currentSessionId}
            attachmentPreviews={attachmentPreviews}
          />
        </div>
      </div>

      {/* Composer */}
      <div style={{ padding: '0 20px 18px', flexShrink: 0 }}>
        <div style={{ maxWidth: 860, margin: '0 auto', width: '100%' }}>
          <div
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            style={{
              border: `1px solid ${inputFocused ? token.colorPrimary : token.colorBorderSecondary}`,
              borderRadius: 20,
              background: token.colorBgContainer,
              boxShadow: inputFocused
                ? `0 0 0 3px ${token.colorPrimaryBg}`
                : '0 1px 2px rgba(0,0,0,0.04)',
              transition: 'border-color 0.15s, box-shadow 0.15s',
              overflow: 'hidden',
            }}
          >
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              accept="application/pdf,image/jpeg,image/png,image/webp,image/gif,.pdf,.jpg,.jpeg,.png,.webp,.gif"
              style={{ display: 'none' }}
              onChange={(event) => void handleAttachmentFiles(event.currentTarget.files)}
            />
            {attachments.length > 0 && (
              <UIImagePreviewGroup>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8, padding: '10px 14px 0' }}>
                  {attachments.map((attachment, index) => (
                    attachment.mediaType.startsWith('image/') ? (
                      <div key={`${attachment.name}-${index}`} style={{ position: 'relative', width: 88, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <UIImagePreview
                          src={`data:${attachment.mediaType};base64,${attachment.data}`}
                          alt={attachment.name}
                          title={`${attachment.name} — click to view full size`}
                          width={88}
                          height={64}
                          style={{ display: 'block', width: 88, height: 64, objectFit: 'cover', borderRadius: 8, cursor: 'zoom-in' }}
                        />
                        <span title={attachment.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: token.colorTextSecondary }}>{attachment.name}</span>
                        <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index))} style={{ position: 'absolute', top: 4, right: 4, width: 20, height: 20, border: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.65)', color: '#fff', cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
                      </div>
                    ) : (
                      <span key={`${attachment.name}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 280, padding: '6px 8px', borderRadius: 8, background: token.colorFillTertiary, fontSize: 12, color: token.colorTextSecondary }}>
                        <UIIcon name="FilePdfOutlined" style={{ fontSize: 16 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.name}</span>
                        <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index))} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1 }}>×</button>
                      </span>
                    )
                  ))}
                </div>
              </UIImagePreviewGroup>
            )}
            <UIInputTextArea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message the agent..."
              autoSize={{ minRows: 1, maxRows: 8 }}
              disabled={isRunning}
              variant="borderless"
              style={{ resize: 'none', padding: '14px 16px 6px', border: 'none', boxShadow: 'none', outline: 'none', fontSize: 14 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={isRunning || attachments.length >= 10}
                  title="Attach PDF or image"
                  aria-label="Attach PDF or image"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: '50%', background: 'transparent', color: token.colorTextSecondary, cursor: isRunning || attachments.length >= 10 ? 'default' : 'pointer', opacity: isRunning || attachments.length >= 10 ? 0.5 : 1 }}
                >
                  <UIIcon name="PaperClipOutlined" style={{ fontSize: 13 }} />
                </button>
                <UISegmented
                  size="small"
                  value={agentMode}
                  onChange={(v) => setAgentMode(v as 'execute' | 'plan')}
                  disabled={isRunning}
                  options={[
                    { value: 'execute', label: 'Execute' },
                    { value: 'plan', label: 'Plan' },
                  ]}
                />
                <UIPopover
                  trigger="click"
                  placement="topLeft"
                  content={
                    <ComposerSettings
                      responseMode={responseMode}
                      setResponseMode={setResponseMode}
                      tier={tier}
                      setTier={setTier}
                      enableEscalation={enableEscalation}
                      setEnableEscalation={setEnableEscalation}
                      disabled={isRunning}
                      token={token}
                    />
                  }
                >
                  <button
                    disabled={isRunning}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '3px 10px',
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderRadius: 999,
                      background: 'transparent',
                      cursor: isRunning ? 'default' : 'pointer',
                      opacity: isRunning ? 0.6 : 1,
                      fontFamily: 'inherit',
                      fontSize: 12,
                      color: token.colorTextSecondary,
                    }}
                  >
                    <UIIcon name="ControlOutlined" style={{ fontSize: 11 }} />
                    <span>{tierLabel(tier)}</span>
                    {enableEscalation && <span style={{ color: token.colorTextTertiary }}>· Auto</span>}
                  </button>
                </UIPopover>
                <ConnectionBadge
                  status={ws.status}
                  sessionId={currentSessionId}
                  onReconnect={() => ws.connect()}
                />
              </div>
              <div>
                {isRunning ? (
                  <button
                    onClick={handleStop}
                    disabled={stopMutation.isLoading}
                    title="Stop"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: '50%',
                      border: 'none',
                      background: token.colorError,
                      color: token.colorTextLightSolid,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: stopMutation.isLoading ? 'default' : 'pointer',
                    }}
                  >
                    <UIIcon name={stopMutation.isLoading ? 'LoadingOutlined' : 'StopOutlined'} style={{ fontSize: 13, color: 'inherit' }} />
                  </button>
                ) : (
                  <button
                    onClick={handleStart}
                    disabled={!canSend}
                    title="Send"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: '50%',
                      border: 'none',
                      background: canSend ? token.colorText : token.colorFillTertiary,
                      color: canSend ? token.colorBgContainer : token.colorTextQuaternary,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: canSend ? 'pointer' : 'default',
                      transition: 'background 0.15s',
                    }}
                  >
                    <UIIcon name={startRunMutation.isLoading ? 'LoadingOutlined' : 'ArrowUpOutlined'} style={{ fontSize: 13, color: 'inherit' }} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentsPage;
