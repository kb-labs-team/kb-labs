export interface CompositeSignal {
  signal: AbortSignal
  dispose(): void
}

export interface TimeoutSignal {
  signal: AbortSignal
  cancel(): void
}

export function combineSignals(
  signals: Array<AbortSignal | null | undefined>,
): CompositeSignal {
  const filtered = signals.filter(
    (signal): signal is AbortSignal => signal != null,
  )
  if (filtered.length === 0) {
    const controller = new AbortController()
    return { signal: controller.signal, dispose: () => controller.abort() }
  }
  if (filtered.length === 1) {
    return { signal: filtered[0]!, dispose: () => {} }
  }

  const controller = new AbortController()
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []

  const abortFrom = (source: AbortSignal): void => {
    if (controller.signal.aborted) {
      return
    }
    const reason = getAbortReason(source)
    if (reason !== undefined) {
      controller.abort(reason)
    } else {
      controller.abort()
    }
  }

  for (const signal of filtered) {
    if (signal.aborted) {
      abortFrom(signal)
      break
    }
    const listener = () => abortFrom(signal)
    signal.addEventListener('abort', listener, { once: true })
    listeners.push({ signal, listener })
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener('abort', listener)
      }
    },
  }
}

export function createTimeoutSignal(
  timeoutMs: number,
  reasonFactory: () => Error,
): TimeoutSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(reasonFactory())
    }
  }, timeoutMs)

  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
    },
  }
}

export function signalReason(signal: AbortSignal): string | undefined {
  if (!signal.aborted) {
    return undefined
  }
  const reason = getAbortReason(signal)
  if (reason instanceof Error) {
    return reason.message
  }
  if (typeof reason === 'string') {
    return reason
  }
  return undefined
}

export function getAbortReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason
}

