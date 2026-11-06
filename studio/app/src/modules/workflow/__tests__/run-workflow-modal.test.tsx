import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DynamicField, runWithRequiredInputs } from '../components/RunWorkflowModal.js';

describe('RunWorkflowModal input validation', () => {
  // case: S-022.4
  it('keeps the required field error and sends no run request for empty input', () => {
    const onRun = vi.fn();
    const errors = runWithRequiredInputs(
      'greet',
      { name: { type: 'string', required: true } },
      { name: '   ' },
      onRun,
    );

    expect(errors).toEqual({ name: 'name is required' });
    expect(onRun).not.toHaveBeenCalled();
  });

  it('allows valid required values and optional falsy values', () => {
    const onRun = vi.fn();
    const values = { name: 'Ada', enabled: false, count: 0 };
    const errors = runWithRequiredInputs(
      'greet',
      {
        name: { type: 'string', required: true },
        enabled: { type: 'boolean', required: true },
        count: { type: 'number', required: true },
      },
      values,
      onRun,
    );

    expect(errors).toEqual({});
    expect(onRun).toHaveBeenCalledWith('greet', values);
  });

  it('associates an accessible field-level error with the required input', () => {
    const field = DynamicField({
      name: 'name',
      schema: { type: 'string', required: true },
      value: '',
      error: 'name is required',
      onChange: vi.fn(),
    });
    const children = field.props.children as React.ReactNode[];
    const input = children[1] as React.ReactElement<Record<string, unknown>>;
    const error = children[2] as React.ReactElement<Record<string, unknown>>;

    expect(input.props).toMatchObject({
      id: 'workflow-input-name',
      'aria-invalid': true,
      'aria-describedby': 'workflow-input-name-error',
    });
    expect(error.props).toMatchObject({
      id: 'workflow-input-name-error',
      role: 'alert',
      children: 'name is required',
    });
  });
});
