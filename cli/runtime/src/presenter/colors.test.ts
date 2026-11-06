import { afterEach, describe, expect, it, vi } from 'vitest';
import { colorPolicy } from '@kb-labs/plugin-contracts/color-policy';

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
});

describe('CLI presenter color policy', () => {
  // case: S-278.1, S-278.2, S-278.3
  it.each(colorPolicy.cases)('$name', async ({ tty, noColor, forceColor, term, want }) => {
    vi.stubEnv('NO_COLOR', noColor);
    vi.stubEnv('FORCE_COLOR', forceColor ?? undefined);
    vi.stubEnv('TERM', term);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: tty });
    vi.resetModules();

    const { colors } = await import('./colors.js');
    expect(/\u001b\[/.test(colors.red('color-policy-probe'))).toBe(want);

    const { colors: sharedColors } = await import('@kb-labs/shared-cli-ui');
    expect(/\u001b\[/.test(sharedColors.error('color-policy-probe'))).toBe(want);
  });
});
