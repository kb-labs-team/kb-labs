import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { RunInputs } from '../pages/WorkflowRunDetail.js';

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
