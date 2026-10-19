/**
 * Config-bound test: infra/bootstrap/ (the remote-state bucket and lock table,
 * #641) is a separate Terraform root module with its own provider lock. The
 * two lock files must stay identical so a plan in either directory runs the
 * same hashicorp/aws build. Dependabot bumps them in two PRs (dependabot.yml,
 * terraform ecosystem); merging one without the other turns this red, and the
 * fix is to copy infra/.terraform.lock.hcl over the bootstrap one.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { ROOT } from './workflows';

const PARENT_LOCK = path.join(ROOT, 'infra/.terraform.lock.hcl');
const BOOTSTRAP_LOCK = path.join(ROOT, 'infra/bootstrap/.terraform.lock.hcl');

describe('Terraform provider lock parity (infra/ vs infra/bootstrap/)', () => {
  it('pins the same hashicorp/aws version and hashes in both root modules', () => {
    const parent = readFileSync(PARENT_LOCK, 'utf8');
    const bootstrap = readFileSync(BOOTSTRAP_LOCK, 'utf8');
    expect(parent).toMatch(/provider "registry\.terraform\.io\/hashicorp\/aws"/);
    expect(bootstrap).toBe(parent);
  });
});
