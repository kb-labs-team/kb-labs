import { mcpToolError } from './request-handler.js';

// @ts-expect-error MCP callers cannot add undeclared diagnostic details.
mcpToolError({ code: 'KB_AUTH_REQUIRED', details: { gatewayUrl: 'https://gateway.test', undeclared: 'missing' } });
