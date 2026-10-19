/**
 * Config-bound test over the CAA record in infra/dns.tf (#758).
 *
 * ACM checks CAA before every issuance and renewal of aws_acm_certificate.main
 * (api.<domain>, *.<domain>, <domain>). If one of Amazon's four CA identities
 * drops out of the `issue` or `issuewild` list, the next renewal fails and the
 * API's certificate expires with no code change to blame. The record covers
 * every zone, served or not, and deliberately carries no `iodef` entry (it
 * would publish an inbox in public DNS).
 */
import path from 'path';
import { resourceBlock } from './terraform';
import { ROOT } from './workflows';

const DNS_TF = path.join(ROOT, 'infra/dns.tf');
const AMAZON_CAS = ['amazon.com', 'amazontrust.com', 'awstrust.com', 'amazonaws.com'];

describe('infra/dns.tf — CAA record', () => {
  const block = resourceBlock(DNS_TF, 'aws_route53_record', 'caa');

  it('is a CAA record at the apex of every zone in var.domains', () => {
    expect(block).toMatch(/^\s*for_each\s*=\s*var\.domains\s*$/m);
    expect(block).toMatch(/^\s*name\s*=\s*each\.key\s*$/m);
    expect(block).toMatch(/^\s*type\s*=\s*"CAA"\s*$/m);
  });

  it.each(AMAZON_CAS)('allows ACM to issue and renew: issue and issuewild for %s', (ca) => {
    expect(block).toContain(`"0 issue \\"${ca}\\""`);
    expect(block).toContain(`"0 issuewild \\"${ca}\\""`);
  });

  it('publishes no mailbox (no iodef entry)', () => {
    expect(block).not.toMatch(/iodef/);
  });
});
