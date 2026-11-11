import type { Readable } from 'node:stream';
import { requireInteractiveInput } from '@kb-labs/shared-cli-ui/interactive';

export async function readPasswordFromStdin(input: Readable = process.stdin): Promise<string> {
  let value = '';
  for await (const chunk of input) {
    value += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  return value.replace(/\r?\n$/, '');
}

export async function promptForPassword(command: string): Promise<string> {
  const input = process.stdin;
  requireInteractiveInput(command, 'The password prompt requires an interactive terminal.');
  if (!input.setRawMode) {throw new Error('The terminal does not support secure password input.');}
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  process.stderr.write('Password: ');
  return new Promise((resolve, reject) => {
    let password = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Password entry was cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(password);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          password = password.slice(0, -1);
          continue;
        }
        password += character;
      }
    };
    input.on('data', onData);
  });
}
