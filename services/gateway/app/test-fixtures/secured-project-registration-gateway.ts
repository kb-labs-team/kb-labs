import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createInMemoryDocumentDatabase } from '@kb-labs/sdk/testing';
import type { ICache, ILogger } from '@kb-labs/core-platform';
import {
  ApiTokensStore,
  CredentialsStore,
  ensureBootstrapAdmin,
  evaluateAuthReadiness,
  createEmailPasswordProvider,
  createPasswordPolicy,
  createStubPDP,
  createTenantResolver,
  createUserAuthService,
  InvitesStore,
  MembershipsStore,
  PasswordResetStore,
  ProviderRegistry,
  SessionsStore,
  UsersStore,
} from '@kb-labs/gateway-auth';
import { PlatformAuditStore } from '@kb-labs/core-platform';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { registerAuthHealthRoute } from '../src/auth/health-route.js';
import { registerUserAuthRoutes } from '../src/auth/user-routes.js';
import { registerGatewayUxBoundary } from '../src/ux-boundary.js';
import { createProjectsRoutes } from '../../../host/app/src/projects-routes.js';
import { createProjectRegistry } from '@kb-labs/core-project-registry';
import type { ProjectRuntimeManager } from '../../../host/app/src/project-runtime/manager.js';

const HOUR = 60 * 60 * 1000;
const TENANT_ID = 'workspace';
const EMAIL = 'admin@example.test';
const PASSWORD = 'bootstrap-password-for-test';
const jwtConfig = { secret: 'test-secret-at-least-32-chars-long!!' };
const logger: ILogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  debug: () => {},
  trace: () => {},
  child: () => logger,
};
const cache: ICache = {
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined,
  clear: async () => undefined,
};

async function run(): Promise<void> {
  const kbHome = process.env.KB_HOME;
  if (!kbHome) { throw new Error('KB_HOME is required for the secured project-registration fixture'); }

  const docs = createInMemoryDocumentDatabase();
  const users = new UsersStore(docs);
  const credentials = new CredentialsStore(docs);
  const memberships = new MembershipsStore(docs);
  const sessions = new SessionsStore(docs, { refreshTtlMs: HOUR, graceWindowMs: 5_000 });
  const apiTokens = new ApiTokensStore(docs);
  const invites = new InvitesStore(docs);
  const passwordResets = new PasswordResetStore(docs);
  const authAudit = new PlatformAuditStore(docs);
  const providers = new ProviderRegistry();
  providers.register(createEmailPasswordProvider({ users, credentials, tenantId: TENANT_ID, bcryptCost: 4 }));
  const pdp = createStubPDP({ memberships });
  const userAuthService = createUserAuthService({
    users,
    credentials,
    memberships,
    sessions,
    invites,
    passwordResets,
    providers,
    passwordPolicy: createPasswordPolicy({ minLength: 8, maxLength: 256, hibpEnabled: false }),
    jwtConfig,
    accessTtlSec: 900,
    refreshTtlSec: HOUR / 1000,
    bcryptCost: 4,
  });
  const tenantResolver = createTenantResolver({ pattern: '{tenant}.kblabs.ru' });
  const bootstrapStatus = await ensureBootstrapAdmin({
    bootstrap: { adminEmail: EMAIL, adminPassword: PASSWORD, tenantId: TENANT_ID },
    users,
    credentials,
    memberships,
    providers: await providers.operationalList(),
    bcryptCost: 4,
    logger,
  });

  const app = Fastify({ logger: false, trustProxy: true });
  registerGatewayUxBoundary(app, logger);
  registerAuthHealthRoute(app, async () => evaluateAuthReadiness({
    authEnabled: true,
    loopbackOnly: true,
    tenantId: TENANT_ID,
    jwtSecretIsDefault: false,
    bootstrap: { status: bootstrapStatus, email: EMAIL },
    users,
    credentials,
    memberships,
    providers: await providers.operationalList(),
  }));
  await app.register(fastifyCookie);
  app.addHook('onRequest', createAuthMiddleware(cache, jwtConfig, {
    authEnabled: true,
    userAuth: { users, sessions, apiTokens, pdp, tenantResolver, jwtConfig },
  }));
  registerUserAuthRoutes(app, {
    userAuthService,
    users,
    memberships,
    sessions,
    apiTokens,
    invites,
    authAudit,
    providers,
    pdp,
    tenantResolver,
    bootstrapTenantId: TENANT_ID,
    cookieOpts: { cookieSecure: false },
    accessTtlSec: 900,
    refreshTtlSec: HOUR / 1000,
    inviteTtlMs: 7 * 24 * HOUR,
    jwtConfig,
  });
  const registry = createProjectRegistry({ root: kbHome });
  const manager = { status: () => ({ limit: 4, active: 0, runtimes: [] }) } as unknown as ProjectRuntimeManager;
  const projectRoutes = createProjectsRoutes({ registry, manager });
  await app.register(projectRoutes);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') { throw new Error('secured Gateway fixture did not bind a TCP port'); }
  process.stdout.write(`READY http://127.0.0.1:${address.port}\n`);
  process.once('SIGTERM', () => { void app.close(); });
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'secured Gateway fixture failed'}\n`);
  process.exitCode = 1;
});
