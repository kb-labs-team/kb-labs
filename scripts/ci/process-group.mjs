import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';

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

async function settleGroup(groupId, initialSignal, deadline) {
  signalGroup(groupId, initialSignal);
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
export function runProcessGroup(command, args, {
  cwd, env, stdio = 'inherit', graceMs = 4000, reapGraceMs = 1000, cancellationDeadlineFile,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio, detached: true });
    let requestedSignal;
    let childResult;
    let childError;
    let cleanupStarted = false;
    let escalationTimer;
    let cleanupDeadline;
    let killDeadline;
    let escalationSent = false;
    const handlers = new Map();

    const ensureEscalation = () => {
      if (!cleanupDeadline || escalationTimer || !child.pid) return;
      const delay = Math.max(0, killDeadline - Date.now());
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        if (child.pid) {
          escalationSent = true;
          signalGroup(child.pid, 'SIGKILL');
        }
      }, delay);
    };

    const forward = (signal) => {
      requestedSignal ??= signal;
      beginCleanupDeadline();
      if (child.pid) signalGroup(child.pid, requestedSignal);
      ensureEscalation();
    };

    const beginCleanupDeadline = () => {
      cleanupDeadline ??= Date.now() + graceMs;
      killDeadline ??= cleanupDeadline + reapGraceMs;
      if (cancellationDeadlineFile) {
        const temporary = `${cancellationDeadlineFile}.${process.pid}.tmp`;
        try {
          mkdirSync(dirname(cancellationDeadlineFile), { recursive: true, mode: 0o700 });
          writeFileSync(temporary, `${Math.trunc(cleanupDeadline)}\n`, { mode: 0o600 });
          renameSync(temporary, cancellationDeadlineFile);
        } catch (error) {
          childError ??= error;
        }
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => forward(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    child.once('spawn', () => {
      if (requestedSignal) {
        signalGroup(child.pid, requestedSignal);
        ensureEscalation();
      }
    });

    const finish = async () => {
      if (cleanupStarted || !childResult) return;
      cleanupStarted = true;
      beginCleanupDeadline();
      ensureEscalation();
      if (child.pid) {
        try {
          await settleGroup(child.pid, escalationSent ? 'SIGKILL' : requestedSignal ?? 'SIGTERM', killDeadline);
        } catch (error) {
          childError ??= error;
        }
      }
      if (escalationTimer) clearTimeout(escalationTimer);
      for (const [signal, handler] of handlers) process.off(signal, handler);
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
