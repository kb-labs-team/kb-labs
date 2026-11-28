/**
 * @module @kb-labs/studio-app/pages/change-password-page
 *
 * Password change page (ADR-0020, Phase 2.7).
 *
 * POST /api/auth/password/change with { currentPassword, newPassword }.
 * On success: shows confirmation message; user stays logged in
 * (other devices are signed out server-side by revoking their refresh families).
 *
 * All mutations use the shared authClient which injects CSRF headers automatically.
 */

import * as React from 'react';
import { normalizeStudioFailure } from '@kb-labs/studio-federation';
import { authClient } from '../auth/shared-client.js';

export function ChangePasswordPage() {
  const [current, setCurrent] = React.useState('');
  const [newPwd, setNewPwd] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<{ message: string; hint?: string } | null>(null);
  const [success, setSuccess] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPwd.length < 8) {
      setError({ message: 'New password must be at least 8 characters' });
      return;
    }

    if (newPwd !== confirm) {
      setError({ message: 'Passwords do not match' });
      return;
    }

    setLoading(true);
    try {
      await authClient.fetch<unknown>('/auth/password/change', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: newPwd }),
      });

      setSuccess(true);
      setCurrent('');
      setNewPwd('');
      setConfirm('');
    } catch (err: unknown) {
      const body = (err as { body?: { error?: unknown } })?.body;
      const legacyMessage = typeof body?.error === 'string' ? body.error : undefined;
      const failure = normalizeStudioFailure(body);
      setError({
        message: legacyMessage ?? failure.message,
        ...(!legacyMessage && failure.hint ? { hint: failure.hint } : {}),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '400px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '1.5rem' }}>
        Change Password
      </h1>

      {success && (
        <p
          role="status"
          style={{
            color: 'var(--color-success, #52c41a)',
            marginBottom: '1rem',
            fontSize: '0.9rem',
          }}
        >
          Your password has been changed. Other devices have been signed out.
        </p>
      )}

      <form
        aria-label="change password form"
        onSubmit={(e) => { void handleSubmit(e); }}
        noValidate
      >
        {/* Current password */}
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="pwd-current" style={{ display: 'block', marginBottom: '0.375rem', fontWeight: 500 }}>
            Current password
          </label>
          <input
            id="pwd-current"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            style={inputStyle}
          />
        </div>

        {/* New password */}
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="pwd-new" style={{ display: 'block', marginBottom: '0.375rem', fontWeight: 500 }}>
            New password
          </label>
          <input
            id="pwd-new"
            type="password"
            autoComplete="new-password"
            required
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            style={inputStyle}
          />
        </div>

        {/* Confirm new password */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label htmlFor="pwd-confirm" style={{ display: 'block', marginBottom: '0.375rem', fontWeight: 500 }}>
            Confirm new password
          </label>
          <input
            id="pwd-confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={inputStyle}
          />
        </div>

        {error && (
          <p role="alert" style={{ color: 'var(--color-error, #ff4d4f)', marginBottom: '1rem', fontSize: '0.875rem' }}>
            {error.message}
            {error.hint && <><br />{error.hint}</>}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '0.7rem',
            borderRadius: '6px',
            background: loading ? '#aaa' : 'var(--color-primary, #667eea)',
            color: '#fff',
            fontWeight: 600,
            fontSize: '0.95rem',
            border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  borderRadius: '6px',
  border: '1px solid var(--border-primary, #d9d9d9)',
  fontSize: '0.9rem',
  boxSizing: 'border-box',
};
