#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { validateProductConfig } = await import(path.join(root, 'core/config/dist/index.js'));
const { createRegistryJourneyConfig } = await import('./registry-journey-config.mjs');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const outputRoot = argument('--output');
const registryUrl = argument('--registry-url');
const platformSuite = process.argv.includes('--platform-suite');
if (!outputRoot || !registryUrl) {
  process.stderr.write('usage: render-journey-composition.mjs --output <directory> --registry-url <url>\n');
  process.exit(2);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const config = createRegistryJourneyConfig({ registryUrl, signingPublicKey: publicPem });
const configValidation = validateProductConfig('marketplace', config.marketplace);
if (!configValidation.ok) {
  process.stderr.write(`Registry journey config is invalid: ${JSON.stringify(configValidation.errors)}\n`);
  process.exit(1);
}

const kbRoot = path.join(path.resolve(outputRoot), '.kb');
await mkdir(kbRoot, { recursive: true, mode: 0o700 });
const configOverridePath = path.join(kbRoot, 'kb.config.override.json');
await writeFile(configOverridePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await writeFile(path.join(kbRoot, 'registry.env'), `KB_REGISTRY_SIGNING_KEY='${privatePem.trimEnd()}\n'\n`, { mode: 0o600 });
const gatewaySecretPath = path.join(kbRoot, 'gateway-internal.env');
await writeFile(gatewaySecretPath, `GATEWAY_INTERNAL_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
await chmod(gatewaySecretPath, 0o600);

const profile = platformSuite ? '' : '    profiles: [marketplace-registry]\n';
const network = platformSuite ? '' : '    networks: [journey]\n';
const clientService = platformSuite ? `  platform:
    env_file:
      - ${JSON.stringify(gatewaySecretPath)}
    environment:
      KB_E2E_REGISTRY_UPSTREAM: ${JSON.stringify(registryUrl)}
    depends_on:
      marketplace-registry:
        condition: service_started
    volumes:
      - ${JSON.stringify(`${path.join(root, 'e2e/platform/entrypoint.sh')}:/entrypoint.sh:ro`)}
      - ${JSON.stringify(`${path.join(root, 'e2e/platform/registry-install-request.mjs')}:/registry-install-request.mjs:ro`)}
` : `  runner:
    env_file:
      - ${JSON.stringify(gatewaySecretPath)}
    environment:
      KB_JOURNEY_MARKETPLACE_PUBLISH_URL: ${JSON.stringify(`${registryUrl}/api/v1`)}
      KB_JOURNEY_MARKETPLACE_AUTHOR_HANDLE: journey
`;
const tamperService = platformSuite ? '' : `  marketplace-tamper:
    profiles: [marketplace-registry]
    image: python:3.12-alpine
    command: ["python3", "/fixture/marketplace_tamper_proxy.py"]
    environment:
      MARKETPLACE_TAMPER_UPSTREAM: http://marketplace-registry:5071
    volumes:
      - ${JSON.stringify(`${path.join(root, 'e2e/journey/marketplace_tamper_proxy.py')}:/fixture/marketplace_tamper_proxy.py:ro`)}
    depends_on:
      marketplace-registry:
        condition: service_started
    networks: [journey]
`;
const composeOverlay = `services:
${clientService}
  marketplace-state:
${profile}    image: kb-marketplace-state:journey
    build:
      context: ${JSON.stringify(root)}
      dockerfile: services/state/daemon/Dockerfile
${network}
  marketplace-registry:
${profile}    image: kb-marketplace-registry:journey
    build:
      context: ${JSON.stringify(root)}
      dockerfile: services/marketplace-registry/app/Dockerfile
    depends_on:
      marketplace-state:
        condition: service_started
    env_file:
      - ${JSON.stringify(gatewaySecretPath)}
      - ${JSON.stringify(path.join(kbRoot, 'registry.env'))}
    environment:
      KB_REGISTRY_HOST: 0.0.0.0
      KB_REGISTRY_PORT: "5071"
      # The Registry emits a Gateway-relative public tarball path.
      KB_REGISTRY_URL: /api/v1/marketplace-registry
      KB_STATE_DAEMON_URL: http://marketplace-state:7777
    volumes:
      - ${JSON.stringify(`${configOverridePath}:/app/.kb/kb.config.override.json:ro`)}
${network}
${tamperService}`;
const composeOverlayPath = path.join(path.resolve(outputRoot), 'docker-compose.registry.yml');
await writeFile(composeOverlayPath, composeOverlay, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  composeOverlayPath,
  configOverridePath,
  signingPublicKeyBase64: Buffer.from(publicPem).toString('base64'),
})}\n`);
