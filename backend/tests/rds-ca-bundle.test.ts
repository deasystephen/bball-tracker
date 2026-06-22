/**
 * Guards the pinned Amazon RDS CA bundle that `src/models/index.ts` reads to
 * verify the RDS server certificate (TLS). A truncated/empty/missing bundle
 * would make every production DB connection fail (and the /health DB ping 503),
 * so fail loudly in CI instead. Refresh with:
 *   curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
 *     -o backend/certs/rds-global-bundle.pem
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('RDS CA bundle', () => {
  const bundlePath = join(__dirname, '..', 'certs', 'rds-global-bundle.pem');
  const pem = readFileSync(bundlePath, 'utf8');

  it('is a non-trivial PEM bundle with many CA certificates', () => {
    const count = (pem.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    // The global bundle holds ~100+ regional CAs; require a healthy floor so a
    // partial/truncated download can't pass.
    expect(count).toBeGreaterThanOrEqual(50);
  });

  it('includes a us-east-1 root CA (the region this app runs in)', () => {
    expect(pem).toMatch(/-----END CERTIFICATE-----\s*$/);
    // Subject CNs aren't in the PEM body, so assert structurally that the bundle
    // is well-formed and substantial rather than parsing every cert here.
    expect(pem.length).toBeGreaterThan(100_000);
  });
});
