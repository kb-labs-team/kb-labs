import { useEffect, useState, useRef, useCallback } from 'react';

// ─── Types ─────────────────────────────────────────────────────────

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface UseWebSocketOptions<TReceive> {
  /** Enable/disable auto-connect on mount (default: true) */
  enabled?: boolean;
  /** Auto-reconnect on close/error (default: false) */
  reconnect?: boolean;
  /** Max reconnect attempts (default: 5) */
  maxReconnects?: number;
  /** Base reconnect delay in ms, doubles each attempt (default: 2000) */
  reconnectIntervalMs?: number;
  /** WebSocket sub-protocols */
  protocols?: string | string[];
  /** Parse incoming messages (default: JSON.parse) */
  parse?: (raw: string) => TReceive;
  /** Serialize outgoing messages (default: JSON.stringify) */
  serialize?: (data: unknown) => string;
  /** Max messages to keep in history (default: 100) */
  maxMessages?: number;
  /** Called on each received message */
  onMessage?: (data: TReceive) => void;
  /** Called on connection open */
  onOpen?: (event: Event) => void;
  /** Called on connection close */
  onClose?: (event: CloseEvent) => void;
  /** Called on error */
  onError?: (event: Event) => void;
}

export interface UseWebSocketReturn<TSend, TReceive> {
  /** Send a typed message (auto-serialized) */
  send: (data: TSend) => void;
  /** Send a raw string */
  sendRaw: (data: string | ArrayBufferLike | Blob) => void;
  /** Received messages (most recent last) */
  messages: TReceive[];
  /** Latest received message */
  latest: TReceive | undefined;
  /** Connection status */
  status: WebSocketStatus;
  /** Shorthand: status === 'connected' */
  isConnected: boolean;
  /** Last error event */
  error: Event | null;
  /** Manually open the connection */
  connect: () => void;
  /** Manually close the connection */
  disconnect: (code?: number, reason?: string) => void;
  /** Clear message history */
  clear: () => void;
  /** Current reconnect attempt count */
  reconnectCount: number;
}

// ─── Hook ──────────────────────────────────────────────────────────

/**
 * Generic WebSocket hook for bidirectional communication.
 *
 * Pass `null` as url to keep the hook mounted but inactive.
 *
 * @example
 * ```tsx
 * // Agent chat
 * const { send, messages, isConnected } = useWebSocket<UserMsg, AgentMsg>(
 *   sessionId ? `ws://localhost:4000/agent/${sessionId}` : null,
 * );
 * send({ type: 'user_message', text: input });
 *
 * // With reconnect and callbacks
 * const { messages, status } = useWebSocket<Command, StatusEvent>(
 *   '/ws/deploy',
 *   {
 *     reconnect: true,
 *     onMessage: (msg) => msg.done && showNotification('Deploy finished'),
 *   },
 * );
 * ```
 */
export function useWebSocket<TSend = unknown, TReceive = unknown>(
  url: string | null,
  options: UseWebSocketOptions<TReceive> = {},
): UseWebSocketReturn<TSend, TReceive> {
  const {
    enabled = true,
    reconnect = false,
    maxReconnects = 5,
    reconnectIntervalMs = 2000,
    protocols,
    parse = defaultParse,
    serialize = defaultSerialize,
    maxMessages = 100,
    onMessage,
    onOpen,
    onClose,
    onError,
  } = options;

  const [messages, setMessages] = useState<TReceive[]>([]);
  const [latest, setLatest] = useState<TReceive | undefined>(undefined);
  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const [error, setError] = useState<Event | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUser = useRef(false);
  const connectionGeneration = useRef(0);

  // Stable refs for callbacks
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  const onErrorRef = useRef(onError);
  const parseRef = useRef(parse);
  const serializeRef = useRef(serialize);
  onMessageRef.current = onMessage;
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;
  onErrorRef.current = onError;
  parseRef.current = parse;
  serializeRef.current = serialize;

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const doConnect = useCallback(() => {
    if (!url) { return; }

    const generation = ++connectionGeneration.current;
    cleanup();
    closedByUser.current = false;
    setStatus('connecting');
    setError(null);

    let attempt = 0;

    function open() {
      if (generation !== connectionGeneration.current) { return; }
      const resolvedUrl = resolveWsUrl(url!);
      const ws = protocols ? new WebSocket(resolvedUrl, protocols) : new WebSocket(resolvedUrl);
      wsRef.current = ws;

      ws.onopen = (e) => {
        if (generation !== connectionGeneration.current) { return; }
        attempt = 0;
        setReconnectCount(0);
        setStatus('connected');
        setError(null);
        onOpenRef.current?.(e);
      };

      ws.onmessage = (e: MessageEvent) => {
        if (generation !== connectionGeneration.current) { return; }
        try {
          const data = parseRef.current(e.data as string) as TReceive;
          setLatest(data);
          setMessages((prev) => {
            const next = [...prev, data];
            return maxMessages > 0 && next.length > maxMessages ? next.slice(-maxMessages) : next;
          });
          onMessageRef.current?.(data);
        } catch {
          // Silently ignore parse errors for binary/non-JSON frames
        }
      };

      ws.onclose = (e) => {
        if (generation !== connectionGeneration.current) { return; }
        wsRef.current = null;
        setStatus('disconnected');
        onCloseRef.current?.(e);

        if (closedByUser.current) { return; }

        // Reconnect on abnormal close
        if (reconnect && attempt < maxReconnects && e.code !== 1000) {
          attempt++;
          setReconnectCount(attempt);
          const delay = reconnectIntervalMs * Math.pow(2, attempt - 1);
          reconnectTimer.current = setTimeout(open, delay);
        }
      };

      ws.onerror = (e) => {
        if (generation !== connectionGeneration.current) { return; }
        setStatus('error');
        setError(e);
        onErrorRef.current?.(e);
      };
    }

    open();
  }, [url, protocols, reconnect, maxReconnects, reconnectIntervalMs, maxMessages, cleanup]);

  const disconnect = useCallback((code?: number, reason?: string) => {
    closedByUser.current = true;
    connectionGeneration.current += 1;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close(code, reason);
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  const send = useCallback((data: TSend) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(serializeRef.current(data));
    }
  }, []);

  const sendRaw = useCallback((data: string | ArrayBufferLike | Blob) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setLatest(undefined);
  }, []);

  // Auto-connect on mount / url change
  useEffect(() => {
    if (!url || !enabled) {
      connectionGeneration.current += 1;
      closedByUser.current = true;
      cleanup();
      setStatus('disconnected');
      return;
    }

    setMessages([]);
    setLatest(undefined);
    doConnect();

    return () => {
      closedByUser.current = true;
      connectionGeneration.current += 1;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enabled]);

  return {
    send,
    sendRaw,
    messages,
    latest,
    status,
    isConnected: status === 'connected',
    error,
    connect: doConnect,
    disconnect,
    clear,
    reconnectCount,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function defaultParse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function defaultSerialize(data: unknown): string {
  return JSON.stringify(data);
}

/** Resolve relative paths to ws:// or wss:// using the configured API origin */
function resolveWsUrl(url: string): string {
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return url;
  }
  const path = url.startsWith('/') ? url : `/${url}`;
  // Use configured API gateway origin when available, otherwise fall back to current origin
  if (typeof window !== 'undefined') {
    const cfg = (window as unknown as Record<string, unknown>)['__KB_STUDIO_CONFIG__'] as Record<string, string> | undefined;
    const base = cfg?.KB_API_BASE_URL;
    if (base) {
      try {
        const origin = new URL(base).origin;
        const proto = origin.startsWith('https') ? 'wss:' : 'ws:';
        return `${proto}//${new URL(origin).host}${path}`;
      } catch { /* fall through */ }
    }
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}
