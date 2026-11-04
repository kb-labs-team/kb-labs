/**
 * User confirmation prompt utilities
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';

/**
 * Prompt user for yes/no confirmation
 *
 * @param question - Question to ask
 * @param defaultValue - Default value if user just presses Enter
 * @param autoConfirm - If true, automatically return true without prompting (for --yes flag)
 * @returns Promise resolving to true if user confirms, false otherwise
 */
export async function promptUserConfirmation(
  question: string,
  writeOutput: (text: string) => void,
  defaultValue: boolean = false,
  autoConfirm: boolean = false
): Promise<boolean> {
  // Auto-confirm mode (--yes flag)
  if (autoConfirm) {
    writeOutput(`${question} [auto-confirmed with --yes]\n`);
    return true;
  }

  // Ensure stdin is active — it may have been paused by a previous readline
  // interface or by the spinner's clearInterval side effects
  if (!process.stdin.readableEnded) {
    process.stdin.resume();
  }

  const output = new Writable({
    write(chunk, _encoding, callback) {
      writeOutput(chunk.toString());
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
  });

  const defaultHint = defaultValue ? '[Y/n]' : '[y/N]';
  const fullQuestion = `${question} ${defaultHint}: `;

  return new Promise((resolve) => {
    rl.question(fullQuestion, (answer) => {
      rl.close();

      const normalized = answer.trim().toLowerCase();

      if (normalized === '') {
        resolve(defaultValue);
        return;
      }

      if (normalized === 'y' || normalized === 'yes') {
        resolve(true);
        return;
      }

      if (normalized === 'n' || normalized === 'no') {
        resolve(false);
        return;
      }

      // Invalid input - use default
      resolve(defaultValue);
    });
  });
}
