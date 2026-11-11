// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import typedFailure from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/failure.json';
import { normalizeStudioFailure } from '@kb-labs/studio-federation';
import { WidgetErrorBoundary } from '../widget-error-boundary.js';

function renderFailure(error: Error) {
  const boundary = new WidgetErrorBoundary({
    pluginId: '@kb-labs/test-widget',
    widgetId: 'summary',
    children: null,
  });
  boundary.state = { hasError: true, failure: normalizeStudioFailure(error), copied: false };
  return render(boundary.render());
}

describe('Studio widget error boundary', () => {
  // case: S-203.5
  it('shows typed fixture fields and safe correlated unexpected errors', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const typedError = Object.assign(new Error(typedFailure.error.message), typedFailure.error);
    const typed = renderFailure(typedError);
    expect(document.body.textContent).toContain(typedFailure.error.code);
    expect(document.body.textContent).toContain(typedFailure.error.message);
    expect(document.body.textContent).toContain(typedFailure.error.hint);
    expect(document.body.textContent).toContain(typedFailure.error.correlationId);
    expect(screen.getByText('Copy diagnostics')).toBeTruthy();
    typed.unmount();

    const unexpected = renderFailure(new Error('private widget error'));
    expect(document.body.textContent).toContain('KB_RUNTIME_UNEXPECTED');
    expect(document.body.textContent).not.toContain('private widget error');
    expect(document.body.textContent).toContain('Correlation ID:');
    expect(screen.getByText('Copy diagnostics')).toBeTruthy();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private widget error');
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('private widget error');
    unexpected.unmount();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });
});
