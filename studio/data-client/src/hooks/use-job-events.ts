/**
 * @module @kb-labs/studio-data-client/hooks/use-job-events
 * React hook for subscribing to job events via SSE with fallback to polling
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { isUxResult } from '@kb-labs/core-platform/ux-result';
import { toErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import type { JobEventType } from './types';

// Type for job response data
interface JobResponseData {
  jobId: string;
  status: string;
  progress?: number;
  error?: string;
}

function isJobResponseData(value: unknown): value is JobResponseData {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'jobId' in value && typeof value.jobId === 'string'
    && 'status' in value && typeof value.status === 'string'
    && (!('progress' in value) || typeof value.progress === 'number')
    && (!('error' in value) || typeof value.error === 'string');
}

/** Decode the Gateway UX-result envelope used by JSON job endpoints. */
export function decodeJobResponseData(value: unknown): JobResponseData {
  if (!isUxResult(value)) {throw new Error('Gateway returned an invalid result envelope for the job response.');}
  if (!value.ok) {
    const error = toErrorEnvelope(value.error);
    throw new Error(`${error.code}: ${error.message} — ${error.hint}${error.correlationId ? ` (correlationId: ${error.correlationId})` : ''}`);
  }
  if (!isJobResponseData(value.data)) {throw new Error('Gateway returned an invalid job response payload.');}
  return value.data;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function statusToEventType(status: string): JobEventType {
  if (status === 'completed') { return 'job.finished'; }
  if (status === 'failed') { return 'job.failed'; }
  if (status === 'running') { return 'job.started'; }
  return 'job.queued';
}

/**
 * Job event structure
 */
export interface JobEvent {
  type: JobEventType;
  jobId: string;
  timestamp: string;
  data?: {
    status?: string;
    progress?: number;
    error?: string;
  };
}

/**
 * Hook options
 */
export interface UseJobEventsOptions {
  enabled?: boolean;
  pollInterval?: number; // Polling interval in ms (fallback mode)
  baseUrl?: string;
  onEvent?: (event: JobEvent) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

/**
 * Hook result
 */
export interface UseJobEventsResult {
  events: JobEvent[];
  isConnected: boolean;
  error: Error | null;
  reconnect: () => void;
}

/**
 * Use job events hook with SSE support and polling fallback
 */
export function useJobEvents(
  jobId: string | null,
  options: UseJobEventsOptions = {}
): UseJobEventsResult {
  const {
    enabled = true,
    pollInterval = 1000,
    baseUrl = '',
    onEvent,
    onError,
    onComplete,
  } = options;

  const [events, setEvents] = useState<JobEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const useSSERef = useRef(true); // Try SSE first

  const reconnect = useCallback(() => {
    // Clear existing connections
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    
    // Reset state
    setEvents([]);
    setError(null);
    setIsConnected(false);
    useSSERef.current = true;
  }, []);

  useEffect(() => {
    if (!enabled || !jobId) {
      return;
    }

    const eventsUrl = `${baseUrl}/jobs/${jobId}/events`;

    // Try SSE first
    if (useSSERef.current) {
      try {
        const eventSource = new EventSource(eventsUrl);
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          setIsConnected(true);
          setError(null);
        };

        eventSource.onmessage = (e) => {
          try {
            const event: JobEvent = JSON.parse(e.data);
            setEvents((prev) => [...prev, event]);
            onEvent?.(event);

            // Check if job is complete
            if (event.type === 'job.finished' || event.type === 'job.failed') {
              eventSource.close();
              setIsConnected(false);
              onComplete?.();
            }
          } catch (_err) {
            setError(_err instanceof Error ? _err : new Error('Failed to parse event'));
            onError?.(_err instanceof Error ? _err : new Error('Failed to parse event'));
          }
        };

        eventSource.onerror = (_event) => {
          // SSE failed, fallback to polling
          eventSource.close();
          eventSourceRef.current = null;
          useSSERef.current = false;
          setIsConnected(false);
          
          // Start polling fallback
          const poll = async () => {
            try {
              const response = await fetch(`${baseUrl}/jobs/${jobId}`);
              if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
              }
              
              const data = decodeJobResponseData(await response.json());
              const currentStatus = data.status;
              
              // Check if status changed
              const lastEvent = events[events.length - 1];
              if (!lastEvent || lastEvent.data?.status !== currentStatus) {
                const event: JobEvent = {
                  type: statusToEventType(currentStatus),
                  jobId,
                  timestamp: new Date().toISOString(),
                  data: {
                    status: currentStatus,
                    progress: data.progress,
                    error: data.error,
                  },
                };
                
                setEvents((prev) => [...prev, event]);
                onEvent?.(event);

                if (TERMINAL_STATUSES.has(currentStatus)) {
                  if (pollingRef.current) {
                    clearInterval(pollingRef.current);
                    pollingRef.current = null;
                  }
                  onComplete?.();
                }
              }
            } catch (_err) {
              const errorInstance = _err instanceof Error ? _err : new Error('Polling failed');
              setError(errorInstance);
              onError?.(errorInstance);
            }
          };

          // Start polling immediately
          poll();
          pollingRef.current = setInterval(poll, pollInterval);
        };

        // Cleanup
        return () => {
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
        };
      } catch (_err) {
        // SSE not supported, fallback to polling
        useSSERef.current = false;
      }
    }

    // Polling fallback (if SSE not available or disabled)
    if (!useSSERef.current && !pollingRef.current) {
      const poll = async () => {
        try {
          const response = await fetch(`${baseUrl}/jobs/${jobId}`);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          
          const data = decodeJobResponseData(await response.json());
          const currentStatus = data.status;
          
          // Check if status changed
          setEvents((prev) => {
            const lastEvent = prev[prev.length - 1];
            if (!lastEvent || lastEvent.data?.status !== currentStatus) {
              const event: JobEvent = {
                type: statusToEventType(currentStatus),
                jobId,
                timestamp: new Date().toISOString(),
                data: {
                  status: currentStatus,
                  progress: data.progress,
                  error: data.error,
                },
              };
              
              onEvent?.(event);
              
              if (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'cancelled') {
                if (pollingRef.current) {
                  clearInterval(pollingRef.current);
                  pollingRef.current = null;
                }
                onComplete?.();
              }
              
              return [...prev, event];
            }
            return prev;
          });
          
          setIsConnected(true);
          setError(null);
        } catch (_err) {
          const errorInstance = _err instanceof Error ? _err : new Error('Polling failed');
          setError(errorInstance);
          onError?.(errorInstance);
          setIsConnected(false);
        }
      };

      // Start polling immediately
      poll();
      pollingRef.current = setInterval(poll, pollInterval);

      // Cleanup
      return () => {
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      };
    }
  }, [jobId, enabled, pollInterval, onEvent, onError, onComplete, events]);

  return {
    events,
    isConnected,
    error,
    reconnect,
  };
}
