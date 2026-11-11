import { CredentialsManager } from './credentials.js';
import { SessionManager } from './session.js';
import { credentialMatchesGatewayOrigin, authRequiredForGateway } from './auth-origin.js';
import { decodeGatewayFailure, readGatewaySuccessData } from './result.js';
import { ErrorEnvelopeError } from '@kb-labs/core-platform';
import type { GatewayCredentials, SessionCredentials } from './types.js';
import type { GatewayRequestTarget, GatewayCredentialKind } from './api-client.js';
import { isGatewayConnectionFailure } from './connection-errors.js';

export class AuthSessionVerificationError extends Error {
  constructor(readonly gatewayUrl: string, cause: unknown) {
    super('Gateway session verification failed.', { cause });
    this.name = 'AuthSessionVerificationError';
  }
}

export type AuthCredential = GatewayCredentials | SessionCredentials;
export interface AuthSession {
  readonly kind: 'session' | 'machine';
  readonly gatewayUrl: string;
  readonly accessToken: string;
  refresh(): Promise<AuthSession>;
  save(): Promise<void>;
}
export interface AuthSnapshot {
  session: SessionCredentials | null;
  machine: GatewayCredentials | null;
  sessionPath: string;
  sessionExpired: boolean;
  machineExpired: boolean;
}

const EXPIRY_BUFFER_MS = 60_000;
function authCredentialExpired(credential: AuthCredential): boolean {
  return Date.now() >= credential.expiresAt - EXPIRY_BUFFER_MS;
}

/** The sole owner of saved identity selection, origin checks, refresh, and Gateway auth decoding. */
export class AuthSessionOwner {
  private readonly sessions = new SessionManager();
  private readonly machines = new CredentialsManager();

  async load(kind: GatewayCredentialKind = 'either', target?: GatewayRequestTarget, policy: { refreshExpired?: boolean } = {}): Promise<AuthSession | null> {
    // Human identity is preferred because interactive CLI actions are performed
    // for the signed-in user. Machine identity remains available to machine-only callers.
    const session = kind === 'machine' ? null : await this.sessions.load();
    const machine = session || kind === 'session' ? null : await this.machines.load();
    const selected = session ?? machine;
    if (!selected) { return null; }
    const gatewayUrl = target?.gatewayUrl ?? selected.gatewayUrl;
    if (!credentialMatchesGatewayOrigin(selected.gatewayUrl, gatewayUrl)) { throw authRequiredForGateway(gatewayUrl); }
    if (session) {
      const current = (policy.refreshExpired ?? true) && authCredentialExpired(session) ? await this.refreshSession(session) : session;
      return this.sessionState(current, gatewayUrl);
    }
    if (!machine) { return null; }
    const current = (policy.refreshExpired ?? true) && authCredentialExpired(machine) ? await this.refreshMachine(machine) : machine;
    return this.machineState(current, gatewayUrl);
  }

  async loginMachine(gatewayUrl: string, clientId: string, clientSecret: string): Promise<GatewayCredentials> {
    const response = await fetch(`${gatewayUrl}/auth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    if (!response.ok) { throw await this.decodeFailure('Authentication', response, gatewayUrl); }
    const data = await readGatewaySuccessData<{ accessToken: string; refreshToken: string; expiresIn: number }>(response, {
      operation: 'Authentication', gatewayUrl,
    });
    const credential: GatewayCredentials = { gatewayUrl, accessToken: data.accessToken, refreshToken: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000 };
    const profile = await this.profile<{ handle?: string; namespaceId?: string }>(gatewayUrl, credential.accessToken);
    credential.handle = profile.handle;
    credential.namespaceId = profile.namespaceId;
    await this.machines.save(credential);
    return credential;
  }

  async loginSession(gatewayUrl: string, email: string, password: string): Promise<{ credential: SessionCredentials; expiresIn: number }> {
    const response = await fetch(`${gatewayUrl}/auth/login/cli`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) { throw await this.decodeFailure('Authentication', response, gatewayUrl); }
    const data = await readGatewaySuccessData<{ accessToken: string; refreshToken: string; expiresIn: number; tenantId?: string }>(response, {
      operation: 'Authentication', gatewayUrl,
    });
    const session: SessionCredentials = {
      gatewayUrl, accessToken: data.accessToken, refreshToken: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000, email, tenantId: data.tenantId,
    };
    const profile = await this.profile<{ email?: string; tenantId?: string }>(gatewayUrl, session.accessToken);
    session.email = profile.email ?? session.email;
    session.tenantId = profile.tenantId ?? session.tenantId;
    await this.sessions.save(session);
    return { credential: session, expiresIn: data.expiresIn };
  }

  async clear(): Promise<void> { await Promise.all([this.sessions.clear(), this.machines.clear()]); }

  async logout(): Promise<boolean> {
    const { session, machine } = await this.inspect();
    const credentials = [session, machine].filter((value): value is AuthCredential => value !== null);
    if (credentials.length === 0) { return false; }
    for (const credential of credentials) {
      const response = await fetch(`${credential.gatewayUrl}/auth/logout/cli`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: credential.refreshToken }),
      });
      if (!response.ok) { throw await this.decodeFailure('Token revocation', response, credential.gatewayUrl); }
    }
    await this.clear();
    return true;
  }

  async inspect(): Promise<AuthSnapshot> {
    const [session, machine] = await Promise.all([this.sessions.load(), this.machines.load()]);
    return {
      session, machine, sessionPath: this.sessions.getFilePath(),
      sessionExpired: session ? authCredentialExpired(session) : false,
      machineExpired: machine ? authCredentialExpired(machine) : false,
    };
  }

  async verify(target?: GatewayRequestTarget): Promise<{ auth: AuthSession; response: Response } | null> {
    const auth = await this.load('either', target);
    if (!auth) { return null; }
    let response: Response;
    try {
      response = await fetch(`${auth.gatewayUrl.replace(/\/$/, '')}/auth/me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
    } catch (error) {
      if (isGatewayConnectionFailure(error)) { throw new AuthSessionVerificationError(auth.gatewayUrl, error); }
      throw error;
    }
    return { auth, response };
  }

  async profile<T>(gatewayUrl: string, accessToken: string): Promise<T> {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, '')}/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) { throw await this.decodeFailure('Gateway verification', response, gatewayUrl); }
    return readGatewaySuccessData<T>(response, { operation: 'Gateway verification', gatewayUrl });
  }

  async decodeFailure(operation: string, response: Response, gatewayUrl: string): Promise<ErrorEnvelopeError> {
    return new ErrorEnvelopeError(await decodeGatewayFailure(response, { operation, gatewayUrl }));
  }

  private sessionState(credential: SessionCredentials, gatewayUrl: string): AuthSession {
    return {
      kind: 'session', gatewayUrl, accessToken: credential.accessToken,
      refresh: async () => this.sessionState(await this.refreshSession(credential), gatewayUrl),
      save: () => this.sessions.save(credential),
    };
  }

  private machineState(credential: GatewayCredentials, gatewayUrl: string): AuthSession {
    return {
      kind: 'machine', gatewayUrl, accessToken: credential.accessToken,
      refresh: async () => this.machineState(await this.refreshMachine(credential), gatewayUrl),
      save: () => this.machines.save(credential),
    };
  }

  private async refreshSession(session: SessionCredentials): Promise<SessionCredentials> {
    const response = await this.refreshRequest(session.gatewayUrl, '/auth/refresh/cli', session.refreshToken);
    const data = await readGatewaySuccessData<{ accessToken: string; refreshToken: string; expiresIn: number }>(response, {
      operation: 'Token refresh', gatewayUrl: session.gatewayUrl,
    });
    const updated = { ...session, accessToken: data.accessToken, refreshToken: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000 };
    await this.sessions.save(updated);
    return updated;
  }

  private async refreshMachine(machine: GatewayCredentials): Promise<GatewayCredentials> {
    const response = await this.refreshRequest(machine.gatewayUrl, '/auth/refresh', machine.refreshToken);
    const data = await readGatewaySuccessData<{ accessToken: string; refreshToken: string; expiresIn: number }>(response, {
      operation: 'Token refresh', gatewayUrl: machine.gatewayUrl,
    });
    const updated = { ...machine, accessToken: data.accessToken, refreshToken: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000 };
    await this.machines.save(updated);
    return updated;
  }

  private async refreshRequest(gatewayUrl: string, path: string, refreshToken: string): Promise<Response> {
    const response = await fetch(`${gatewayUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) { throw await this.decodeFailure('Token refresh', response, gatewayUrl); }
    return response;
  }
}
