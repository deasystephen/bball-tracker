/**
 * Config-bound test over the two mail paths of the domain (#555).
 *
 *   - `infra/workspace.tf` — Google Workspace at the apex (people read mail)
 *   - `infra/ses.tf`       — Amazon SES at `mail.<domain>` (the API sends mail)
 *
 * The two must stay on separate names with separate SPF and DKIM, and their
 * DMARC records must carry one policy. A mistake here fails quietly and in
 * production only: invitations land in spam, or reports go nowhere. Every
 * extraction below must succeed — a file that changed shape fails loudly
 * rather than letting the suite pass vacuously.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const INFRA = path.resolve(__dirname, '../../../infra');
const workspaceTf = readFileSync(path.join(INFRA, 'workspace.tf'), 'utf8');
const sesTf = readFileSync(path.join(INFRA, 'ses.tf'), 'utf8');

/** Returns the body of `resource "aws_route53_record" "<name>" { … }`, brace-matched. */
function recordBlock(source: string, name: string, label: string): string {
  const header = new RegExp(`^resource\\s+"aws_route53_record"\\s+"${name}"\\s*\\{`, 'm').exec(source);
  if (!header) {
    throw new Error(
      `${label}: could not find resource "aws_route53_record" "${name}". If the file changed shape, ` +
        'update tests/infra/workspace-mail.test.ts — do not let this test pass vacuously.'
    );
  }
  const start = header.index + header[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i);
  }
  throw new Error(`${label}: resource "aws_route53_record" "${name}" has no closing brace.`);
}

/** Drops `#` comments, so prose about a rule cannot satisfy or break an assertion on the code. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

const WORKSPACE_RECORDS = ['workspace_apex_txt', 'workspace_mx', 'workspace_dkim', 'workspace_dmarc'];

describe('Mail DNS — Google Workspace at the apex, SES on the mail subdomain', () => {
  it('the apex SPF authorizes Google and not SES', () => {
    const apexTxt = recordBlock(workspaceTf, 'workspace_apex_txt', 'workspace.tf');

    expect(apexTxt).toContain('"v=spf1 include:_spf.google.com ~all"');
    expect(apexTxt).not.toMatch(/amazonses/);
  });

  it('the MAIL FROM SPF authorizes SES and not Google', () => {
    const mailFromSpf = recordBlock(sesTf, 'ses_mail_from_spf', 'ses.tf');

    expect(mailFromSpf).toContain('"v=spf1 include:amazonses.com ~all"');
    expect(mailFromSpf).not.toMatch(/google/);
  });

  it('no Workspace record is on the mail subdomain', () => {
    for (const name of WORKSPACE_RECORDS) {
      const block = recordBlock(workspaceTf, name, 'workspace.tf');
      const recordName = /^\s*name\s*=\s*(.+)$/m.exec(block);
      if (!recordName) throw new Error(`workspace.tf: ${name} has no name.`);

      expect(recordName[1]).toContain('var.primary_domain');
      expect(recordName[1]).not.toMatch(/mail\./);
    }
  });

  it('both DMARC records carry the one policy declared in workspace.tf', () => {
    const policies = withoutComments(workspaceTf).match(/^\s*dmarc_policy\s*=\s*"([a-z]+)"\s*$/m);
    if (!policies) throw new Error('workspace.tf: could not find local.dmarc_policy.');
    expect(['none', 'quarantine', 'reject']).toContain(policies[1]);

    // A literal DMARC value anywhere else is a second policy waiting to drift.
    expect(withoutComments(sesTf)).not.toMatch(/v=DMARC1/);
    expect(withoutComments(workspaceTf).match(/v=DMARC1/g)).toHaveLength(2);
    expect(withoutComments(workspaceTf)).not.toMatch(/v=DMARC1; p=(none|quarantine|reject)/);

    expect(recordBlock(workspaceTf, 'workspace_dmarc', 'workspace.tf')).toMatch(
      /records\s*=\s*\[local\.dmarc_record_with_reports\]/
    );
    const sesDmarc = recordBlock(sesTf, 'ses_dmarc', 'ses.tf');
    expect(sesDmarc).toContain('local.dmarc_record_with_reports');
    expect(sesDmarc).toContain('local.dmarc_record_no_reports');
  });

  it('reports go to a mailbox on the primary domain, and only that domain names it', () => {
    expect(withoutComments(workspaceTf)).toMatch(
      /^\s*dmarc_report_address\s*=\s*"dmarc@\$\{var\.primary_domain\}"\s*$/m
    );

    // For another served domain the address is external: receivers send no
    // report to it without an authorization record.
    expect(recordBlock(sesTf, 'ses_dmarc', 'ses.tf')).toMatch(
      /local\.workspace_enabled\s*&&\s*each\.key\s*==\s*var\.primary_domain/
    );
  });

  it('every Workspace record is off until the verification value is set', () => {
    expect(withoutComments(workspaceTf)).toMatch(
      /^\s*workspace_enabled\s*=\s*var\.google_site_verification\s*!=\s*""\s*$/m
    );
    for (const name of WORKSPACE_RECORDS) {
      expect(recordBlock(workspaceTf, name, 'workspace.tf')).toMatch(/^\s*count\s*=\s*local\.workspace_enabled\b/m);
    }
  });

  it('splits the DKIM key into strings of at most 255 characters', () => {
    expect(withoutComments(workspaceTf)).toMatch(
      /range\(0,\s*length\(var\.google_dkim_public_key\),\s*255\)\s*:\s*substr\(var\.google_dkim_public_key,\s*start,\s*255\)/
    );
    expect(recordBlock(workspaceTf, 'workspace_dkim', 'workspace.tf')).toMatch(
      /records\s*=\s*\[join\("\\"\\"",\s*local\.google_dkim_chunks\)\]/
    );
  });

  it('no Terraform file carries a literal email address', () => {
    // Role addresses are built from `var.primary_domain`; personal addresses
    // stay in the gitignored terraform.tfvars.
    const literalAddress = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[a-z]{2,}/;
    const offenders = readdirSync(INFRA)
      .filter((file) => file.endsWith('.tf'))
      .filter((file) => literalAddress.test(withoutComments(readFileSync(path.join(INFRA, file), 'utf8'))));

    expect(offenders).toEqual([]);
  });
});
