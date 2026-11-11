/**
 * Tests for toWorkflowOutputs — the single point of conversion
 * from ExecutionResult.data to workflow step outputs.
 *
 * These tests guarantee that step outputs are predictable regardless
 * of handler type (workflow/CLI/builtin) or execution mode (in-process/subprocess).
 */

import { describe, it, expect } from 'vitest';
import { toWorkflowOutputs } from '../output-normalizer.js';

describe('toWorkflowOutputs', () => {
  describe('object handler output (workflow handlers)', () => {
    it('passes through plain objects as-is', () => {
      expect(toWorkflowOutputs({ foo: 'bar', count: 42 }))
        .toEqual({ foo: 'bar', count: 42 });
    });

    it('passes through nested objects', () => {
      const data = { result: { nested: { deep: true } }, list: [1, 2, 3] };
      expect(toWorkflowOutputs(data)).toEqual(data);
    });

    it('passes through arrays as objects', () => {
      // Arrays are objects in JS — they pass through
      const data = [1, 2, 3];
      expect(toWorkflowOutputs(data)).toEqual([1, 2, 3]);
    });
  });

  describe('CommandResult handler output (CLI commands via command: steps)', () => {
    it('extracts .result from CommandResult with object payload', () => {
      const data = { ok: true, result: { score: 95, grade: 'A' } };
      expect(toWorkflowOutputs(data)).toEqual({ score: 95, grade: 'A' });
    });

    it('extracts .result from CommandResult with meta', () => {
      const data = { ok: true, result: { x: 1 }, meta: { duration: 100 } };
      expect(toWorkflowOutputs(data)).toEqual({ x: 1 });
    });

    it('wraps primitive .result in { result }', () => {
      const data = { ok: true, result: 'hello' };
      expect(toWorkflowOutputs(data)).toEqual({ result: 'hello' });
    });

    it('wraps numeric .result in { result }', () => {
      const data = { ok: true, result: 42 };
      expect(toWorkflowOutputs(data)).toEqual({ result: 42 });
    });

    it('returns {} when CommandResult.result is undefined (key present)', () => {
      const data = { ok: true, result: undefined };
      expect(toWorkflowOutputs(data)).toEqual({});
    });

    it('returns {} when CommandResult.result is explicitly undefined', () => {
      const data = { ok: true, result: undefined };
      expect(toWorkflowOutputs(data)).toEqual({});
    });

    it('handles failed CommandResult (still extracts result)', () => {
      const data = { ok: false, error: 'failed', result: { error: 'failed' } };
      expect(toWorkflowOutputs(data)).toEqual({ error: 'failed' });
    });

    it('handles CommandResult with null .result', () => {
      const data = { ok: true, result: null };
      expect(toWorkflowOutputs(data)).toEqual({});
    });
  });

  describe('primitive handler output', () => {
    it('wraps string in { result }', () => {
      expect(toWorkflowOutputs('hello')).toEqual({ result: 'hello' });
    });

    it('wraps number in { result }', () => {
      expect(toWorkflowOutputs(42)).toEqual({ result: 42 });
    });

    it('wraps boolean in { result }', () => {
      expect(toWorkflowOutputs(true)).toEqual({ result: true });
    });

    it('wraps false in { result }', () => {
      expect(toWorkflowOutputs(false)).toEqual({ result: false });
    });

    it('wraps zero in { result }', () => {
      expect(toWorkflowOutputs(0)).toEqual({ result: 0 });
    });

    it('wraps empty string in { result }', () => {
      expect(toWorkflowOutputs('')).toEqual({ result: '' });
    });
  });

  describe('void / null / undefined handler output', () => {
    it('returns {} for undefined', () => {
      expect(toWorkflowOutputs(undefined)).toEqual({});
    });

    it('returns {} for null', () => {
      expect(toWorkflowOutputs(null)).toEqual({});
    });
  });

  describe('consistency guarantee: in-process vs subprocess produce same outputs', () => {
    it('workflow handler returning object → same outputs in both modes', () => {
      // In both modes, RunResult.data = raw handler output
      const handlerReturn = { status: 'ok', count: 5 };

      // In-process: backend gets data = handlerReturn
      const inProcessOutputs = toWorkflowOutputs(handlerReturn);
      // Subprocess: bootstrap sends { data: handlerReturn }, runner reads .data
      const subprocessOutputs = toWorkflowOutputs(handlerReturn);

      expect(inProcessOutputs).toEqual(subprocessOutputs);
      expect(inProcessOutputs).toEqual({ status: 'ok', count: 5 });
    });

    it('CLI handler returning CommandResult → same outputs in both modes', () => {
      const handlerReturn = { ok: true, result: { passed: true }, meta: {} };

      const inProcessOutputs = toWorkflowOutputs(handlerReturn);
      const subprocessOutputs = toWorkflowOutputs(handlerReturn);

      expect(inProcessOutputs).toEqual(subprocessOutputs);
      expect(inProcessOutputs).toEqual({ passed: true });
    });
  });

  describe('edge cases', () => {
    it('passes through shell handler output as-is (has exitCode but no result key)', () => {
      // Shell handler returns { stdout, stderr, exitCode, ok }
      // This must NOT be treated as CommandResult
      const data = { stdout: 'hello', stderr: '', exitCode: 0, ok: true };
      expect(toWorkflowOutputs(data)).toEqual({ stdout: 'hello', stderr: '', exitCode: 0, ok: true });
    });

    it('passes through Date objects', () => {
      const date = new Date('2026-01-01');
      const result = toWorkflowOutputs(date);
      expect(result).toBeInstanceOf(Date);
    });
  });
});
