import { describe, expect, it } from 'vitest';
import { resolveArtifactData } from '../components/artifacts/resolveArtifactData';

const outputs = { report: { count: 2 } };

describe('resolveArtifactData', () => {
  // case: S-021.6
  it('resolves a named step output and the complete outputs object', () => {
    expect(resolveArtifactData('steps.build.outputs.report.count', outputs, 'build')).toBe(2);
    expect(resolveArtifactData('steps.build.outputs', outputs, 'build')).toBe(outputs);
  });

  // case: S-021.6
  it('returns undefined for a source that names a different step', () => {
    const buildOutputs = { steps: { deploy: { outputs } } };
    expect(resolveArtifactData('steps.deploy.outputs.report', buildOutputs, 'build')).toBeUndefined();
  });

  // case: S-021.6
  it('resolves relative sources and reads only own output fields', () => {
    expect(resolveArtifactData('report.count', outputs)).toBe(2);
    expect(resolveArtifactData('outputs.report.count', outputs)).toBe(2);
    expect(resolveArtifactData('outputs.report.toString', outputs)).toBeUndefined();
  });
});
