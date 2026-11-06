// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import typedFailure from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/failure.json';
import type { StudioRegistryV2 } from '@kb-labs/studio-federation';
import { PluginPageV2 } from '../plugin-page-v2.js';
import { RegistryV2Provider } from '../../providers/registry-v2-provider.js';

const registryState = vi.hoisted(() => ({
  registry: {
    schema: 'kb.studio/2' as const,
    schemaVersion: 2 as const,
    generatedAt: '2026-10-02T00:00:00.000Z',
    plugins: [{
      pluginId: '@kb-labs/registry-fixture',
      remoteName: 'registryFixture',
      remoteEntryUrl: '/plugins/registry-fixture/remoteEntry.js',
      pages: [
        { id: 'overview', title: 'Overview', route: '/p/overview', entry: './Overview' },
        { id: 'settings', title: 'Settings', route: '/p/settings', entry: './Settings' },
      ],
      menus: [],
    }],
  } as StudioRegistryV2,
  failure: undefined as unknown,
}));

vi.mock('@kb-labs/studio-federation', async () => {
  const actual = await vi.importActual<typeof import('@kb-labs/studio-federation')>('@kb-labs/studio-federation');
  function RegisteredPageBoundary({ pluginId, pageId }: { pluginId: string; pageId: string }) {
    const error = registryState.failure instanceof Error ? registryState.failure : new Error('invalid fixture');
    const boundary = new actual.PageErrorBoundary({ pluginId, pageId, children: null });
    boundary.state = {
      hasError: true,
      error,
      failure: actual.normalizeStudioFailure(error),
    };
    return boundary.render();
  }
  return { ...actual, initFederation: vi.fn(), PageContainer: RegisteredPageBoundary, recordStudioFailure: vi.fn() };
});

function renderRegisteredPage(route: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RegistryV2Provider apiBaseUrl="/api/v1">
        <MemoryRouter initialEntries={[route]}>
          <Routes><Route path="/p/*" element={<PluginPageV2 />} /></Routes>
        </MemoryRouter>
      </RegistryV2Provider>
    </QueryClientProvider>,
  );
}

describe('Studio federation registry error coverage', () => {
  const registrations = registryState.registry.plugins.flatMap((plugin) =>
    plugin.pages.map((page) => ({ plugin, page })),
  );

  it('discovers plugin page boundaries from the registry response', () => {
    expect(registrations.length).toBeGreaterThan(0);
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: registryState.registry }),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // case: S-203.5
  it('renders typed and unexpected failures for every registered federation page', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const { plugin, page } of registrations) {
      registryState.failure = Object.assign(new Error(typedFailure.error.message), typedFailure.error);
      const typed = renderRegisteredPage(page.route);
      await waitFor(() => expect(document.body.textContent).toContain(typedFailure.error.correlationId));
      expect(document.body.textContent).toContain(typedFailure.error.code);
      expect(document.body.textContent).toContain(typedFailure.error.message);
      expect(document.body.textContent).toContain(typedFailure.error.hint);
      expect(document.body.textContent).toContain(typedFailure.error.correlationId);
      expect(screen.getByText('Copy diagnostics')).toBeTruthy();
      typed.unmount();

      registryState.failure = new Error('private federated page error');
      const unexpected = renderRegisteredPage(page.route);
      await waitFor(() => expect(document.body.textContent).toMatch(/studio-/));
      expect(document.body.textContent).toContain('KB_RUNTIME_UNEXPECTED');
      expect(document.body.textContent).not.toContain('private federated page error');
      expect(document.body.textContent).toContain('Correlation ID:');
      expect(screen.getByText('Copy diagnostics')).toBeTruthy();
      unexpected.unmount();
      expect(plugin.pages).toContain(page);
    }
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private federated page error');
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('private federated page error');
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });
});
