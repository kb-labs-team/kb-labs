import { describe, it, expect } from 'vitest';
import { parseArgs, validateCommandFlags } from '../flags.js';
import { CliError } from '../errors.js';

describe('parseArgs', () => {
  // ── basic command path parsing ───────────────────────────────────────

  it('parses single command', () => {
    const { cmdPath } = parseArgs(['plugins']);
    expect(cmdPath).toEqual(['plugins']);
  });

  it('parses multi-word command', () => {
    const { cmdPath } = parseArgs(['plugins', 'list']);
    expect(cmdPath).toEqual(['plugins', 'list']);
  });

  it('returns empty cmdPath when only flags', () => {
    const { cmdPath } = parseArgs(['--json']);
    expect(cmdPath).toEqual([]);
  });

  // ── global flags ─────────────────────────────────────────────────────

  it('parses --json', () => {
    const { global } = parseArgs(['--json']);
    expect(global.json).toBe(true);
  });

  it('reserves the explicit Gateway URL as a global option', () => {
    const parsed = parseArgs(['project', 'add', '/workspace/project', '--gateway-url', 'http://gateway.example:4321']);

    expect(parsed.global.gatewayUrl).toBe('http://gateway.example:4321');
    expect(parsed.flagsObj.gatewayUrl).toBeUndefined();
  });

  it('parses --help', () => {
    const { global } = parseArgs(['--help']);
    expect(global.help).toBe(true);
  });

  it('parses --version', () => {
    const { global } = parseArgs(['--version']);
    expect(global.version).toBe(true);
  });

  it('parses a value-taking command --version without treating it as the global version request', () => {
    const { global, flagsObj } = parseArgs(['release', 'artifact', 'publish', '--version', '2.121.0-canary.cec6dacc6']);
    expect(global.version).toBeUndefined();
    expect(flagsObj.version).toBe('2.121.0-canary.cec6dacc6');
  });

  it.each([['--version'], ['--version', ''], ['--version', '--json']])(
    'keeps a missing command version in command flags for declaration validation: %j',
    (...args) => {
      const parsed = parseArgs(['release', 'artifact', 'publish', ...args]);
      expect(parsed.global.version).toBeUndefined();
      expect(parsed.flagsObj.version === true || parsed.flagsObj.version === '').toBe(true);
    },
  );

  it('parses --quiet', () => {
    const { global } = parseArgs(['--quiet']);
    expect(global.quiet).toBe(true);
  });

  it('parses --no-color', () => {
    const { global } = parseArgs(['--no-color']);
    expect(global.noColor).toBe(true);
  });

  it('parses --dry-run and adds to flagsObj', () => {
    const { global, flagsObj } = parseArgs(['--dry-run']);
    expect(global.dryRun).toBe(true);
    expect(flagsObj['dry-run']).toBe(true);
    expect(flagsObj['dryRun']).toBe(true); // camelCase version
  });

  it('parses --debug without level', () => {
    const { global } = parseArgs(['--debug']);
    expect(global.debug).toBe(true);
    expect(global.logLevel).toBe('debug');
  });

  it('parses --debug with level (verbose)', () => {
    const { global } = parseArgs(['--debug', 'verbose']);
    expect(global.debug).toBe('verbose');
    expect(global.logLevel).toBe('debug');
  });

  it('parses --debug=inspect (= syntax)', () => {
    const { global } = parseArgs(['--debug=inspect']);
    expect(global.debug).toBe('inspect');
    expect(global.logLevel).toBe('debug');
  });

  it('parses --log-level', () => {
    const { global } = parseArgs(['--log-level', 'warn']);
    expect(global.logLevel).toBe('warn');
  });

  it('parses --profile', () => {
    const { global } = parseArgs(['--profile', 'staging']);
    expect(global.profile).toBe('staging');
  });

  it('parses --profiles-dir', () => {
    const { global } = parseArgs(['--profiles-dir', '/tmp/profiles']);
    expect(global.profilesDir).toBe('/tmp/profiles');
  });

  // ── generic flags (--key value, --key=value, --flag) ─────────────────

  it('parses --key value style', () => {
    const { flagsObj } = parseArgs(['--task-id', '42']);
    expect(flagsObj['task-id']).toBe('42');
    expect(flagsObj['taskId']).toBe('42'); // camelCase
  });

  it('parses --key=value style', () => {
    const { flagsObj } = parseArgs(['--scope=plugins']);
    expect(flagsObj['scope']).toBe('plugins');
  });

  it('parses --key=value with = in value', () => {
    const { flagsObj } = parseArgs(['--filter=name=foo']);
    expect(flagsObj['filter']).toBe('name=foo');
  });

  it('parses boolean flag (no following value)', () => {
    const { flagsObj } = parseArgs(['--force']);
    expect(flagsObj['force']).toBe(true);
  });

  it('treats flag followed by another flag as boolean', () => {
    const { flagsObj } = parseArgs(['--force', '--yes']);
    expect(flagsObj['force']).toBe(true);
    expect(flagsObj['yes']).toBe(true);
  });

  // ── -- separator ─────────────────────────────────────────────────────

  it('stops parsing at -- separator', () => {
    const { cmdPath, rest } = parseArgs(['run', '--', 'extra', '--arg']);
    expect(cmdPath).toEqual(['run']);
    expect(rest).toEqual(['extra', '--arg']);
  });

  // ── mixed commands and flags ─────────────────────────────────────────

  it('handles intermixed commands and flags', () => {
    const { cmdPath, global, flagsObj } = parseArgs([
      'marketplace', 'install', '--json', '--scope', 'plugins',
    ]);
    expect(cmdPath).toEqual(['marketplace', 'install']);
    expect(global.json).toBe(true);
    expect(flagsObj['scope']).toBe('plugins');
  });

  // ── kebab-to-camel conversion ────────────────────────────────────────

  it('converts kebab-case keys to camelCase', () => {
    const { flagsObj } = parseArgs(['--my-long-flag', 'value']);
    expect(flagsObj['myLongFlag']).toBe('value');
    expect(flagsObj['my-long-flag']).toBe('value'); // original preserved
  });
});

describe('validateCommandFlags', () => {
  it('passes when all flags are valid', () => {
    expect(() =>
      validateCommandFlags(
        { mode: 'fast', verbose: true },
        [
          { name: 'mode', type: 'string', choices: ['fast', 'slow'] },
          { name: 'verbose', type: 'boolean' },
        ],
      ),
    ).not.toThrow();
  });

  it('throws CliError on wrong type (boolean expected, got string)', () => {
    expect(() =>
      validateCommandFlags(
        { verbose: 'yes' },
        [{ name: 'verbose', type: 'boolean' }],
      ),
    ).toThrow(CliError);
  });

  it('throws CliError on invalid choice', () => {
    expect(() =>
      validateCommandFlags(
        { mode: 'turbo' },
        [{ name: 'mode', type: 'string', choices: ['fast', 'slow'] }],
      ),
    ).toThrow(CliError);
  });

  it('skips undefined flags without error', () => {
    expect(() =>
      validateCommandFlags(
        {},
        [{ name: 'missing', type: 'string', choices: ['a'] }],
      ),
    ).not.toThrow();
  });
});
