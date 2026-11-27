import { request as playwrightRequest } from '@playwright/test'
import { issueToken, registerAgent } from '@kb-labs/e2e-shared/auth.js'

// Admin cookies must never reach the request context used for Registry assertions.
export async function createRegistryIdentity(): Promise<{ accessToken: string; namespaceId: string }> {
  const registration = await playwrightRequest.newContext()
  try {
    const credentials = await registerAgent(registration)
    const { accessToken } = await issueToken(registration, credentials)
    if (!credentials.namespaceId || !accessToken) throw new Error('Gateway omitted the machine identity')
    return { accessToken, namespaceId: credentials.namespaceId }
  } finally {
    await registration.dispose()
  }
}

export async function getAccessToken(): Promise<string> {
  return (await createRegistryIdentity()).accessToken
}
