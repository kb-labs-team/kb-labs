/**
 * @vitest-environment jsdom
 *
 * HealthPage (stage 6, final slice): renders installation/platform sections
 * from the injected HealthDataSource and queues an update through it — never
 * talking to the launcher control channel directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DataSources, HealthReport } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '../../../providers/data-sources-provider';
import { HealthPage } from '../pages/health-page';

function makeReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    ok: true,
    protocol: 1,
    installation: {
      ok: true,
      checks: [{ id: 'receipt', ok: true, detail: 'platform 2.120.1, receipt r1' }],
    },
    platform: {
      ok: true,
      checks: [{ id: 'host-process', ok: true, detail: 'pid 4242' }],
    },
    ...overrides,
  };
}

function renderPage(sources: Partial<DataSources>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DataSourcesContext.Provider value={sources as DataSources}>
        <HealthPage />
      </DataSourcesContext.Provider>
    </QueryClientProvider>,
  );
}

describe('HealthPage', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  it('renders installation and platform sections as healthy', async () => {
    const getHealth = vi.fn().mockResolvedValue(makeReport());
    renderPage({ health: { getHealth } as never });

    await waitFor(() => expect(screen.getByText('Installation')).toBeDefined());
    expect(screen.getByText('Platform')).toBeDefined();
    expect(screen.getByText('receipt')).toBeDefined();
    expect(screen.getByText('Healthy')).toBeDefined();
  });

  it('flags a failing check with its hint', async () => {
    const getHealth = vi.fn().mockResolvedValue(
      makeReport({
        ok: false,
        platform: {
          ok: false,
          checks: [
            {
              id: 'health',
              ok: false,
              detail: 'The health document cannot be read.',
              hint: 'Run "kb-create restart".',
            },
          ],
        },
      }),
    );
    renderPage({ health: { getHealth } as never });

    await waitFor(() => expect(screen.getByText('Attention needed')).toBeDefined());
    expect(screen.getByText(/health document cannot be read/i)).toBeDefined();
    expect(screen.getByText(/kb-create restart/i)).toBeDefined();
  });

  it('shows a retry action when the control channel is unavailable', async () => {
    const getHealth = vi.fn().mockRejectedValue(new Error('KB_HOST_CONTROL_UNAVAILABLE: unavailable'));
    renderPage({ health: { getHealth } as never });

    await waitFor(() => expect(screen.getByText(/control channel is unavailable/i)).toBeDefined());
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });

  it('queues an update through the Update dialog', async () => {
    const getHealth = vi.fn().mockResolvedValue(makeReport());
    const requestUpdate = vi.fn().mockResolvedValue({
      id: 'upd_1',
      status: 'pending',
      channel: 'stable',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    renderPage({ health: { getHealth, requestUpdate } as never });

    await waitFor(() => expect(screen.getByText('Installation')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /^update$/i }));
    await waitFor(() => expect(screen.getByText(/queue a platform update/i)).toBeDefined());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /queue update/i }));
    });

    await waitFor(() => expect(requestUpdate).toHaveBeenCalledWith({ channel: 'stable' }));
  });
});
