import { spawn } from 'node:child_process';

const SIGNAL_STATUS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function signalGroup(groupId, signal) {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function signalStatus(signal) {
  return SIGNAL_STATUS[signal] ?? 1;
}

function groupExists(groupId) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function settleGroup(groupId, initialSignal, graceMs) {
  signalGroup(groupId, initialSignal);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupExists(groupId)) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  if (groupExists(groupId)) {
    signalGroup(groupId, 'SIGKILL');
    const reapDeadline = Date.now() + 500;
    while (Date.now() < reapDeadline && groupExists(groupId)) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, reapDeadline - Date.now())));
    }
  }
}

/** Run a command in its own process group and reap that group on exit or cancellation. */
export function runProcessGroup(command, args, { cwd, env, stdio = 'inherit', graceMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio, detached: true });
    let requestedSignal;
    let childResult;
    let childError;
    let cleanupStarted = false;
    const handlers = new Map();

    const forward = (signal) => {
      requestedSignal ??= signal;
      if (child.pid) signalGroup(child.pid, requestedSignal);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => forward(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    child.once('spawn', () => {
      if (requestedSignal) signalGroup(child.pid, requestedSignal);
    });

    const finish = async () => {
      if (cleanupStarted || !childResult) return;
      cleanupStarted = true;
      for (const [signal, handler] of handlers) process.off(signal, handler);
      if (child.pid) {
        try {
          await settleGroup(child.pid, requestedSignal ?? 'SIGTERM', graceMs);
        } catch (error) {
          childError ??= error;
        }
      }
      const status = requestedSignal
        ? signalStatus(requestedSignal)
        : childResult.code ?? signalStatus(childResult.signal);
      resolve({ status, error: childError });
    };

    child.once('error', (error) => {
      childError = error;
      childResult = { code: 1, signal: null };
      void finish();
    });
    child.once('close', (code, signal) => {
      childResult = { code, signal };
      void finish();
    });
  });
}
