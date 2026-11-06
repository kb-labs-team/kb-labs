/**
 * Low-level terminal utilities for interactive CLI prompts.
 * All functions check isInteractive() before using raw mode.
 */

import * as readline from 'node:readline';
import { InteractiveInputRequiredError } from '@kb-labs/plugin-contracts';
export { InteractiveInputRequiredError } from '@kb-labs/plugin-contracts';

export interface Key {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence: string;
}

export function isInteractive(): boolean {
  return Boolean(
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !process.env.CI &&
    !process.env.NO_INTERACTIVE
  );
}

/** Fail with a catalogued usage error when a CLI action needs terminal input. */
export function requireInteractiveInput(
  hint: string,
  cause = 'Required input cannot be read in this execution context.',
): void {
  if (isInteractive()) {return;}
  throw new InteractiveInputRequiredError(hint, cause);
}

export function enableRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
}

export function disableRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

export function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

export function clearLines(n: number): void {
  for (let i = 0; i < n; i++) {
    if (i > 0) {process.stdout.write('\x1b[1A');}
    clearLine();
  }
}

export function hideCursor(): void {
  process.stdout.write('\x1b[?25l');
}

export function showCursor(): void {
  process.stdout.write('\x1b[?25h');
}

export function moveCursorUp(n: number): void {
  process.stdout.write(`\x1b[${n}A`);
}

/**
 * Listen for keypresses. Returns an unsubscribe function.
 * Caller is responsible for enabling raw mode before calling.
 */
export function onKeypress(handler: (key: Key) => void): () => void {
  readline.emitKeypressEvents(process.stdin);

  const listener = (_: unknown, key: Key) => {
    if (key) {handler(key);}
  };

  process.stdin.on('keypress', listener);
  process.stdin.resume();

  return () => {
    process.stdin.off('keypress', listener);
    if (process.stdin.listenerCount('keypress') === 0) {
      process.stdin.pause();
    }
  };
}

export function isUpKey(key: Key): boolean {
  return key.name === 'up' || (key.name === 'k' && !key.ctrl);
}

export function isDownKey(key: Key): boolean {
  return key.name === 'down' || (key.name === 'j' && !key.ctrl);
}

export function isEnterKey(key: Key): boolean {
  return key.name === 'return' || key.name === 'enter';
}

export function isEscapeKey(key: Key): boolean {
  return key.name === 'escape' || (key.name === 'c' && key.ctrl) || (key.name === 'q' && !key.ctrl);
}

export function isSpaceKey(key: Key): boolean {
  return key.name === 'space';
}
