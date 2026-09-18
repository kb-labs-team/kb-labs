// Machine-token flow (existing).
export { AuthService } from './service.js';
export {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  // User-token flow (ADR-0020, Phase 1.13).
  signUserAccessToken,
  signUserRefreshToken,
  verifyUserAccessToken,
  verifyUserRefreshToken,
} from './jwt.js';
export type {
  JwtConfig,
  UserAccessPayload,
  UserRefreshPayload,
  SignUserTokenOptions,
} from './jwt.js';
export {
  saveClient,
  getClient,
  getClientByHostId,
  getClientByHandle,
  isHandleTaken,
  verifyClientSecret,
  buildClientRecord,
  saveRefreshToken,
  consumeRefreshToken,
  savePublicKey,
  getPublicKey,
  generateClientId,
  generateClientSecret,
  generateHostId,
} from './store.js';
export type { ClientRecord } from './store.js';

// User-auth flow (ADR-0020, Phase 1.1–1.15).
export { UsersStore, canonicalizeEmail } from './users-store.js';
export type { User, UserStatus, CreateUserInput } from './users-store.js';
export { CredentialsStore } from './credentials-store.js';
export type { Credential, SetCredentialInput } from './credentials-store.js';
export { MembershipsStore } from './memberships-store.js';
export type { Membership, GroupId, AddMembershipInput } from './memberships-store.js';
export { InvitesStore } from './invites-store.js';
export type {
  InviteRecord,
  InviteStatus,
  CreateInviteInput,
  CreateInviteResult,
} from './invites-store.js';
export {
  SessionsStore,
  RefreshNotFoundError,
  RefreshExpiredError,
  RefreshReuseDetectedError,
} from './sessions-store.js';
export type {
  SessionFamily,
  CreateSessionInput,
  CreateSessionResult,
  RotateRefreshResult,
  SessionsStoreOptions,
} from './sessions-store.js';
export { createPasswordPolicy } from './password-policy.js';
export type {
  PasswordPolicy,
  PasswordPolicyOptions,
  PasswordPolicyLogger,
  ValidationResult,
} from './password-policy.js';
export { issueCsrfToken, verifyCsrfToken } from './csrf.js';
export { createRateLimiter } from './rate-limit.js';
export type { RateLimiter, RateLimitConfig, RateLimitResult } from './rate-limit.js';
export { createTenantResolver, RESERVED_SUBDOMAINS } from './tenant-resolver.js';
export type { TenantResolver, TenantResolverOptions } from './tenant-resolver.js';
export { createEmailPasswordProvider } from './providers/email-password.js';
export type { EmailPasswordProviderOptions } from './providers/email-password.js';
export { createOidcProvider } from './providers/oidc.js';
export type { OidcProviderConfig } from './providers/oidc.js';
export { ProviderRegistry } from './provider-registry.js';
export type { ProviderInfo } from './provider-registry.js';
export { loadIdentityProviders, BUILTIN_FACTORIES } from './provider-loader.js';
export type { ProvidersConfig, ProviderConfigEntry } from './provider-loader.js';
export { OAuthStateStore } from './oauth-state-store.js';
export type { OAuthStateRecord, OAuthStateStoreOptions } from './oauth-state-store.js';
export { createStubPDP } from './stub-pdp.js';
export type { StubPDPOptions } from './stub-pdp.js';
// Re-export PDP types from core-contracts so consumers can import everything
// from @kb-labs/gateway-auth without also depending on @kb-labs/core-contracts.
export type { IPolicyDecisionPoint, PolicyDecision, Identity, Resource, PolicyContext } from '@kb-labs/core-contracts';
export { ensureBootstrapAdmin } from './bootstrap-admin.js';
export type {
  BootstrapConfig,
  BootstrapAdminLogger,
  EnsureBootstrapAdminOptions,
} from './bootstrap-admin.js';
export { resetAdmin, ResetAdminError } from './reset-admin.js';
export type {
  ResetAdminOptions,
  ResetAdminResult,
  ResetAdminRepair,
  ResetAdminLogger,
} from './reset-admin.js';
export { ensureBootstrapCliCredentials,CLI_BOOTSTRAP_HANDLE } from './bootstrap-cli-credentials.js';
export type {
  BootstrapCliCredentialsLogger,
  EnsureBootstrapCliCredentialsOptions,
} from './bootstrap-cli-credentials.js';
export { createUserAuthService, AuthError } from './user-auth-service.js';
export type {
  UserAuthServiceOptions,
  PublicUser,
  TokenInfo,
  SessionResult,
  LoginInput,
  DeviceCtx,
  ChangePasswordInput,
  ActivateInput,
  AuthErrorCode,
} from './user-auth-service.js';
