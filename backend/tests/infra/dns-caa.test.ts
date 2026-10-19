/**
 * Config-bound test over the CAA record in infra/dns.tf (#758).
 *
 * ACM checks CAA before every issuance and renewal of aws_acm_certificate.main
 * (api.<domain>, *.<domain>, <domain>). If one of Amazon's four CA identities
 * drops out of the `issue` or `issuewild` list, the next renewal fails and the
 * API's certificate expires with no code change to blame. The record covers
 * every zone (served or not), and the iodef target is the alerts inbox.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { extractBlock, stripComments } from './terraform';
import { ROOT } from './workflows';

const DNS_TF = path.join(ROOT, 'infra/dns.tf');
const AMAZON_CAS = ['amazon.com', 'amazontrust.com', 'awstrust.com', 'amazonaws.com'];

describe('infra/dns.tf — CAA record', () => {
  const block = stripComments(
    extractBlock(readFileSync(DNS_TF, 'utf8'), 'resource', 'aws_route53_record', 'caa', 'infra/dns.tf aws_route53_record.caa'),
  );

  it('is a CAA record at the apex of every zone in var.domains', () => {
    expect(block).toMatch(/^\s*for_each\s*=\s*var\.domains\s*$/m);
    expect(block).toMatch(/^\s*name\s*=\s*each\.key\s*$/m);
    expect(block).toMatch(/^\s*type\s*=\s*"CAA"\s*$/m);
  });

  it.each(AMAZON_CAS)('allows ACM to issue and renew: issue and issuewild for %s', (ca) => {
    expect(block).toContain(`"0 issue \\"${ca}\\""`);
    expect(block).toContain(`"0 issuewild \\"${ca}\\""`);
  });

  it('reports violations to the alerts inbox', () => {
    expect(block).toMatch(/"0 iodef \\"mailto:\$\{var\.alert_email\}\\""/);
  });
});
