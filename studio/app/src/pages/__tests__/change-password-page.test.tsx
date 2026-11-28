/**
 * @vitest-environment jsdom
 *
 * Tests for ChangePasswordPage (ADR-0020, Phase 2.7).
 *
 * Coverage:
 *   - Renders current / new / confirm fields
 *   - Client-side: new !== confirm → error
 *   - Client-side: new < 8 chars → error
 *   - POST /api/auth/password/change called with correct fields
 *   - Success → shows success message, stays logged in
 *   - Server error (wrong current password) → shows error
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../../auth/guards.js';
import type { AuthState } from '../../auth/auth-provider.js';
import { ChangePasswordPage } from '../change-password-page.js';

function makeAuth(): AuthState {
  return {
    status: 'authenticated',
    user: { userId: 'u1', email: 'alice@test.com', tenantId: 'kb-cloud' },
    permissions: new Set(),
    login: vi.fn(),
    logout: vi.fn(),
  } as AuthState;
}

function renderPage(auth = makeAuth()) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={auth}>
        <ChangePasswordPage />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function fill(current: string, newPwd: string, confirm: string) {
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: current } });
  fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: newPwd } });
  fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: confirm } });
}

describe('ChangePasswordPage', () => {
  it('renders current, new, and confirm password fields', () => {
    renderPage();
    expect(screen.getByLabelText(/current password/i)).toBeDefined();
    expect(screen.getByLabelText(/^new password$/i)).toBeDefined();
    expect(screen.getByLabelText(/confirm new password/i)).toBeDefined();
  });

  it('shows error when new password is shorter than 8 characters', async () => {
    renderPage();
    fill('oldpass', 'short', 'short');
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: /change password form/i }));
    });
    expect(screen.getByText(/at least 8/i)).toBeDefined();
  });

  it('shows error when new passwords do not match', async () => {
    renderPage();
    fill('oldpass', 'NewSecret123!', 'Different123!');
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: /change password form/i }));
    });
    expect(screen.getByText(/passwords do not match/i)).toBeDefined();
  });

  it('calls POST /api/auth/password/change with correct body', async () => {
    const mockF = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
    );
    vi.stubGlobal('fetch', mockF);

    renderPage();
    fill('OldPass!', 'NewSecret123!', 'NewSecret123!');

    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: /change password form/i }));
    });

    const call = mockF.mock.calls[0];
    expect(String(call?.[0])).toContain('/api/auth/password/change');
    const body = JSON.parse((call?.[1] as RequestInit)?.body as string);
    expect(body.currentPassword).toBe('OldPass!');
    expect(body.newPassword).toBe('NewSecret123!');
  });

  it('shows success message on successful password change', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
    ));

    renderPage();
    fill('OldPass!', 'NewSecret123!', 'NewSecret123!');

    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: /change password form/i }));
    });

    await waitFor(() =>
      expect(screen.getByText(/password.*changed|changed.*password/i)).toBeDefined(),
    );
  });

  it('shows error on server-side failure (wrong current password)', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({
          ok: false,
          error: {
            code: 'KB_AUTH_INVALID_CURRENT_PASSWORD',
            message: 'Current password is incorrect',
            hint: 'Check the current password and retry the password change.',
          },
        }),
      }),
    ));

    renderPage();
    fill('Wrong!1', 'NewSecret123!', 'NewSecret123!');

    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: /change password form/i }));
    });

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('Current password is incorrect');
      expect(alert.textContent).toContain('Check the current password and retry the password change.');
    });
  });
});
