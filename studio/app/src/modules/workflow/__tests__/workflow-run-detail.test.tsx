import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { ExternalWaitDetails, RunInputs } from '../pages/WorkflowRunDetail.js';

function textContent(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {return String(node)}
  if (Array.isArray(node)) {return node.map(textContent).join(' ')}
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {return textContent(node.props.children)}
  return ''
}

describe('WorkflowRunDetail submitted inputs', () => {
  // case: S-022.3
  it('renders submitted input names and values', () => {
    const element = RunInputs({ inputs: { name: 'Ada' } });
    expect(textContent(element)).toContain('name: Ada');
  });
});

describe('WorkflowRunDetail external wait', () => {
  // case: S-290.2
  it('renders the reason, dependency, and until time from the workflow contract', () => {
    const element = ExternalWaitDetails({ wait: {
      reason: 'upstream deploy',
      dependency: 'release/api',
      until: '2026-11-10T12:30:00.000Z',
    } });
    const text = textContent(element);

    expect(text).toContain('upstream deploy');
    expect(text).toContain('release/api');
    expect(text).toContain('2026-11-10T12:30:00.000Z');
  });
});
