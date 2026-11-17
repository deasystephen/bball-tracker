/**
 * Config-bound test: infra/bootstrap/ (the remote-state bucket and lock table,
 * #641) is a separate Terraform root module with its own provider lock. The
 * two lock files must stay identical so a plan in either directory runs the
 * same hashicorp/aws build. Dependabot bumps them in one grouped PR (one
 * terraform entry in dependabot.yml that lists both directories); the second
 * test below fails if that entry is split again, because a PR that bumps one
 * lock alone can never pass the first. A hand-made bump keeps them level by
 * copying infra/.terraform.lock.hcl over the bootstrap one.
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

  it('has Dependabot bump both locks in one grouped pull request', () => {
    const config = readFileSync(path.join(ROOT, '.github/dependabot.yml'), 'utf8');
    const entries = config
      .split(/^ {2}- package-ecosystem: /m)
      .filter((entry) => entry.startsWith('"terraform"'));
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatch(/^ {4}directories:\n {6}- "\/infra"\n {6}- "\/infra\/bootstrap"\n/m);
    expect(entry).not.toMatch(/^ {4}directory:/m);
    expect(entry).toMatch(/^ {4}groups:\n {6}[\w-]+:\n {8}patterns:\n {10}- "\*"\n/m);
  });
});
