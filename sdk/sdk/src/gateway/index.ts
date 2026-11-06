/** Public Gateway request and authentication API for plugin packages. */
export { gatewayApiFetch, GatewayApiError, type GatewayRequestTarget, type GatewayCredentialKind } from './api-client.js';
export { AuthSessionOwner, AuthSessionVerificationError } from './auth-session.js';
export { CredentialsManager } from './credentials.js';
export { SessionManager, sessionFilePath } from './session.js';
export { readGatewaySuccessData, decodeGatewayFailure, withGatewayUrl } from './result.js';
export { credentialMatchesGatewayOrigin, authRequiredForGateway } from './auth-origin.js';
export { SavedAuthFileError, savedAuthFileErrorEnvelope } from './saved-auth-file.js';
export { isGatewayConnectionFailure } from './connection-errors.js';
export type {
  GatewayCredentials,
  SessionCredentials,
  GatewayClientConfig,
  GatewayExecuteRequest,
  IGatewayClient,
  ICredentialsManager,
  ISessionManager,
} from './types.js';
