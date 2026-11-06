// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import type { RouteObject } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import typedFailure from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/failure.json';
import { router } from '../../router.js';
import { ErrorBoundary } from '../error-boundary.js';

const routeErrorState = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useRouteError: () => routeErrorState.value,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  };
});

vi.mock('@kb-labs/studio-federation', async () => {
  const actual = await vi.importActual<typeof import('@kb-labs/studio-federation')>('@kb-labs/studio-federation');
  return { ...actual, recordStudioFailure: vi.fn() };
});

function registeredRouteBoundaries(routes: RouteObject[], parentPath = ''): Array<{ id: string; element: ReactNode }> {
  return routes.flatMap((route, index) => {
    const path = [parentPath, route.path ?? `index-${index}`].filter(Boolean).join('/');
    const own = isValidElement(route.errorElement) && route.errorElement.type === ErrorBoundary
      ? [{ id: path, element: route.errorElement }]
      : [];
    return [...own, ...registeredRouteBoundaries(route.children ?? [], path)];
  });
}

const routeBoundaries = registeredRouteBoundaries(router.routes);

describe('registered Studio route error boundaries', () => {
  it('discovers route boundaries from the router registry', () => {
    expect(routeBoundaries.length).toBeGreaterThan(0);
  });

  // case: S-203.5
  it('renders typed and unexpected failures for every route boundary in the router registry', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const { element } of routeBoundaries) {
      routeErrorState.value = typedFailure;
      const typedRender = render(element);
      expect(document.body.textContent).toContain(typedFailure.error.code);
      expect(document.body.textContent).toContain(typedFailure.error.message);
      expect(document.body.textContent).toContain(typedFailure.error.hint);
      expect(document.body.textContent).toContain(typedFailure.error.correlationId);
      expect(screen.getByText('Copy diagnostics')).toBeTruthy();
      typedRender.unmount();

      routeErrorState.value = new Error('private raw route error');
      const unexpectedRender = render(element);
      expect(document.body.textContent).toContain('KB_RUNTIME_UNEXPECTED');
      expect(document.body.textContent).not.toContain('private raw route error');
      expect(document.body.textContent).not.toContain('Error: private raw route error');
      expect(screen.getByText('Copy diagnostics')).toBeTruthy();
      unexpectedRender.unmount();
    }
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private raw route error');
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('private raw route error');
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  }, 30_000);
});
