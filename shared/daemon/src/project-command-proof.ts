import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Internal module header proving the runtime guard authenticated a request. */
export const PROJECT_COMMAND_EXECUTION_PROOF_HEADER = "x-kb-project-command-proof";
export const PROJECT_RUNTIME_TOKEN_ENV = "KB_PROJECT_RUNTIME_TOKEN";

const PROOF_CONTEXT = "kb-project-command-execution-v1";
const PROOF_TTL_MS = 30_000;
const consumedProofs = new Map<string, number>();

export interface ProjectCommandExecutionProofContext {
  projectId: string;
  method: string;
  path: string;
}

function proofSignature(runtimeToken: string, context: ProjectCommandExecutionProofContext, timestamp: string, nonce: string): Buffer {
  const payload = [PROOF_CONTEXT, context.projectId, context.method.toUpperCase(), context.path, timestamp, nonce].join("\n");
  return createHmac("sha256", runtimeToken).update(payload).digest();
}

export function createProjectCommandExecutionProof(runtimeToken: string, context: ProjectCommandExecutionProofContext): string {
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString("base64url");
  return `${timestamp}.${nonce}.${proofSignature(runtimeToken, context, timestamp, nonce).toString("hex")}`;
}

export function matchesProjectCommandExecutionProof(
  runtimeToken: string,
  received: unknown,
  context: ProjectCommandExecutionProofContext,
  now = Date.now(),
): boolean {
  if (typeof received !== "string") { return false; }
  const [timestamp, nonce, signature, ...extra] = received.split(".");
  if (extra.length || !timestamp || !/^\d{13}$/.test(timestamp) || !nonce || !/^[A-Za-z0-9_-]{24}$/.test(nonce) || !signature || !/^[a-f0-9]{64}$/.test(signature)) { return false; }
  const createdAt = Number(timestamp);
  // Use an exclusive expiry boundary everywhere: a proof is invalid exactly
  // when its nonce leaves the replay cache, not one millisecond later.
  if (createdAt > now + 5_000 || now - createdAt >= PROOF_TTL_MS) { return false; }
  const expected = proofSignature(runtimeToken, context, timestamp, nonce);
  const actual = Buffer.from(signature, "hex");
  if (!timingSafeEqual(expected, actual)) { return false; }
  for (const [key, expiresAt] of consumedProofs) { if (expiresAt <= now) { consumedProofs.delete(key); } }
  if (consumedProofs.size >= 10_000) { return false; }
  const nonceKey = `${context.projectId}:${nonce}`;
  if (consumedProofs.has(nonceKey)) { return false; }
  consumedProofs.set(nonceKey, createdAt + PROOF_TTL_MS);
  return true;
}
