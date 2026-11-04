import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function writeTestPlatformReceipt(root: string): void {
  const receiptPath = path.join(root, '.kb', 'v2', 'receipt.json');
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify({
    id: 'test-receipt',
    installationId: 'test-installation',
    plan: {
      request: { gatewayUrl: 'http://127.0.0.1:4100' },
      serviceGraph: { platformVersion: 'test' },
    },
    verification: { hostHealthUrl: 'http://127.0.0.1:4100/health' },
  }));
  const developmentManifest = path.join(root, 'core', 'runtime', 'package.json');
  mkdirSync(path.dirname(developmentManifest), { recursive: true });
  writeFileSync(developmentManifest, JSON.stringify({ name: '@kb-labs/core-runtime', version: 'test' }));
}
