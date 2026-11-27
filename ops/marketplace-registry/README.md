# Marketplace Registry production runbook

This Compose stack serves the public, read-only Marketplace Registry API on `api.kblabs.ru`. It is a separate project from the existing web and Verdaccio stacks. Only Gateway is published on host loopback (`127.0.0.1:4000`); Registry and State have no host ports and communicate on an internal Docker network.

The production deployment on 2026-11-24 uses these verified Linux/amd64 images:

| Service | Image tag |
| --- | --- |
| State daemon | `7b8240395009fc3a055916bb4cef00c1821bf4b3` |
| Gateway | `c5ab24959020f552306fee629abacabd6f921db8` |
| Marketplace Registry | `d708bdb8aa5d7be0513146fd935df59ac30dbc9e` |

The Registry signing key is generated for this deployment and stored on the server at `/home/deploy/kb-marketplace-registry/signing-private.pem` and in the protected `production.env` used by Compose. The private key must never be committed, printed, or replaced during an ordinary image update. Its public key is [registry-public-key.pem](./registry-public-key.pem); SHA256 fingerprint (DER) is `4b7efba8281c95472a34130fcfab36dc828b7ebf60ac7dccebc406e5d68eabc7`.

## Consumer configuration

The standard release default still uses npmjs.org. A platform that opts into this Registry must pin the production public key explicitly in `marketplace.sources`:

```json
{
  "marketplace": {
    "sources": [
      {
        "kind": "registry",
        "url": "https://api.kblabs.ru/api/v1/marketplace-registry",
        "signingPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAc6RfAt8enkIaGnnfnYmzI8NnhEVnFU4lIXnzrT5IpFM=\n-----END PUBLIC KEY-----\n"
      }
    ]
  }
}
```

Keep this key pin when configuring a consumer; a successful HTTPS connection alone does not establish package signature trust. Changing the signing key requires a deliberate trust-key rotation for consumers.

## Start and verify

On the VPS, keep the Compose files and `production.env` in `/home/deploy/kb-marketplace-registry`. The environment file contains secrets and the multiline PEM signing key; set it to mode `0600` and keep the deployment directory private (`0700`). Its required values are the three verified image tags, `KB_REGISTRY_URL`, `KB_SITE_URL`, `GATEWAY_JWT_SECRET`, `GATEWAY_INTERNAL_SECRET`, `GATEWAY_BOOTSTRAP_ADMIN_PASSWORD`, and `KB_REGISTRY_SIGNING_KEY`.

Validate the topology and start the isolated project:

```sh
cd /home/deploy/kb-marketplace-registry
docker compose -p kb-marketplace-registry-prod --env-file production.env -f docker-compose.registry.yml config --quiet
docker compose -p kb-marketplace-registry-prod --env-file production.env -f docker-compose.registry.yml up -d
docker compose -p kb-marketplace-registry-prod --env-file production.env -f docker-compose.registry.yml ps
```

The named volumes `registry_storage_data`, `registry_state_data`, and `registry_gateway_data` preserve package files, State journal data, and Gateway SQLite auth data. Never use `down -v` for production. Back up all three volumes before planned storage or platform migrations. Registry is a single writer; do not scale it to multiple replicas.

Check Gateway readiness and both public catalog aliases:

```sh
curl --fail --silent http://127.0.0.1:4000/ready
curl --fail --silent https://api.kblabs.ru/api/v1/registry/packages
curl --fail --silent https://api.kblabs.ru/api/v1/marketplace-registry/api/v1/packages
```

The public endpoint must pass normal system certificate and hostname verification. The Nginx vhost redirects HTTP to HTTPS and allowlists only read routes; it enforces per-client request/concurrency limits and does not log query parameters. Check the active edge config after changes with:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

## Access boundary and publishing

The public `api.kblabs.ru` edge exposes catalog, resolve, metadata, and tarball reads only. Publish, account, and project routes are intentionally unavailable through this host. The author API is reachable only through the loopback-bound Gateway/private trusted path; do not expose the Gateway broadly or add an Nginx identity header. A separate authenticated author ingress needs its own review before use.

No package is present in the production catalog at initial deployment. The isolated staging flow verified a scoped package install, Ed25519 signature, and retained metadata/tarball after hard-stop/recreate; this was performed with a different temporary key and did not populate production. Do not claim public installation is ready until a package has been deliberately published through an authorized author workflow.

## Image updates and recovery

Use only image artifacts whose SHA256, source revision, image config digest, and clean Docker load identity passed hosted verification. Load the verified artifacts on the VPS, update only the three image tag values in `production.env`, then run `docker compose ... up -d` and repeat the readiness and TLS checks above. Keep the existing volumes and signing key across ordinary updates. If a key is suspected compromised, rotate it with an explicit consumer key migration; do not silently generate a replacement.

The deployment uses local filesystem storage on the VPS root disk. At initial deployment the disk had 6.8 GB free of 19 GB and the Registry contained no packages; monitor available disk before accepting large artifacts.
