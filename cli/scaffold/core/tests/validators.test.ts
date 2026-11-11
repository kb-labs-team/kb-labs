import { describe, it, expect } from 'vitest';
import {
  validatePackageName,
  validateScope,
  validateSemver,
} from '../src/validators.js';

describe('validators', () => {
  it('accepts good package names', () => {
    expect(validatePackageName('my-plugin')).toBeNull();
  });

  it('rejects uppercase', () => {
    expect(validatePackageName('MyPlugin')).not.toBeNull();
  });

  it('rejects reserved', () => {
    expect(validatePackageName('sdk')).not.toBeNull();
    expect(validatePackageName('core')).not.toBeNull();
  });

  it('accepts valid scopes', () => {
    expect(validateScope('@kb-labs')).toBeNull();
    expect(validateScope('')).toBeNull();
  });

  it('rejects bad scopes', () => {
    expect(validateScope('kb-labs')).not.toBeNull();
    expect(validateScope('@KB')).not.toBeNull();
  });

  it('semver', () => {
    expect(validateSemver('1.2.3')).toBeNull();
    expect(validateSemver('1.2')).not.toBeNull();
  });
});
