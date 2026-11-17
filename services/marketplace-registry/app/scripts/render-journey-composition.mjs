#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { validateProductConfig } = await import(path.join(root, 'core/config/dist/index.js'));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const outputRoot = argument('--output');
const registryUrl = argument('--registry-url');
if (!outputRoot || !registryUrl) {
  process.stderr.write('usage: render-journey-composition.mjs --output <directory> --registry-url <url>\n');
  process.exit(2);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const gatewayInternalSecret = randomBytes(32).toString('hex');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const config = {
  marketplace: {
    sources: [{ kind: 'registry', url: registryUrl, signingPublicKey: publicPem }],
  },
};
const configValidation = validateProductConfig('marketplace', config.marketplace);
if (!configValidation.ok) {
  process.stderr.write(`Registry journey config is invalid: ${JSON.stringify(configValidation.errors)}\n`);
  process.exit(1);
}

const kbRoot = path.join(path.resolve(outputRoot), '.kb');
await mkdir(kbRoot, { recursive: true, mode: 0o700 });
await writeFile(path.join(kbRoot, 'kb.config.override.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await writeFile(path.join(kbRoot, 'registry.env'), `KB_REGISTRY_SIGNING_KEY='${privatePem.trimEnd()}\n'\n`, { mode: 0o600 });
const gatewaySecretPath = path.join(kbRoot, 'gateway-internal.secret');
await writeFile(gatewaySecretPath, gatewayInternalSecret, { mode: 0o444 });

const composeOverlay = `secrets:
  journey-gateway-internal:
    file: ${JSON.stringify(gatewaySecretPath)}

services:
  runner:
    secrets: [journey-gateway-internal]
    environment:
      KB_JOURNEY_GATEWAY_INTERNAL_SECRET_FILE: /run/secrets/journey-gateway-internal
      KB_JOURNEY_MARKETPLACE_GATEWAY_URL: "http://127.0.0.1:4000"
      KB_JOURNEY_MARKETPLACE_SERVICE_URL: ${JSON.stringify(registryUrl)}
      KB_JOURNEY_MARKETPLACE_AUTHOR_HANDLE: journey

  marketplace-state:
    profiles: [marketplace-registry]
    image: ${JSON.stringify(`kb-marketplace-state:${process.env.KB_JOURNEY_IMAGE_TAG ?? 'journey'}`)}
    build:
      context: ${JSON.stringify(root)}
      dockerfile: services/state/daemon/Dockerfile
      args:
        KB_DEPLOY_ROOT: ${JSON.stringify(process.env.KB_JOURNEY_DEPLOY_ROOT ?? '.kb/deploy')}
    networks: [journey]

  marketplace-registry:
    profiles: [marketplace-registry]
    image: ${JSON.stringify(`kb-marketplace-registry:${process.env.KB_JOURNEY_IMAGE_TAG ?? 'journey'}`)}
    build:
      context: ${JSON.stringify(root)}
      dockerfile: services/marketplace-registry/app/Dockerfile
      args:
        KB_DEPLOY_ROOT: ${JSON.stringify(process.env.KB_JOURNEY_DEPLOY_ROOT ?? '.kb/deploy')}
    depends_on:
      marketplace-state:
        condition: service_started
    env_file:
      - ${JSON.stringify(path.join(kbRoot, 'registry.env'))}
    secrets: [journey-gateway-internal]
    entrypoint: ["/bin/sh", "-c"]
    command: ["GATEWAY_INTERNAL_SECRET=$(cat /run/secrets/journey-gateway-internal); export GATEWAY_INTERNAL_SECRET; exec /app/docker-entrypoint.sh node dist/bootstrap.js"]
    environment:
      KB_REGISTRY_HOST: 0.0.0.0
      KB_REGISTRY_PORT: "5071"
      KB_REGISTRY_URL: http://marketplace-tamper:8081
    volumes:
      - ${JSON.stringify(`${path.join(kbRoot, 'kb.config.override.json')}:/app/.kb/kb.config.override.json:ro`)}
    networks: [journey]

  marketplace-tamper:
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
const composeOverlayPath = path.join(path.resolve(outputRoot), 'docker-compose.registry.yml');
await writeFile(composeOverlayPath, composeOverlay, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  composeOverlayPath,
  signingPublicKeyBase64: Buffer.from(publicPem).toString('base64'),
})}\n`);
