/**
 * Tests for buildContentDisposition — RFC 5987 attachment header helper.
 */

import { buildContentDisposition } from '../../src/utils/content-disposition';

describe('buildContentDisposition', () => {
  it('emits both filename and filename* for ASCII inputs', () => {
    const h = buildContentDisposition('report.csv');
    expect(h).toBe('attachment; filename="report.csv"; filename*=UTF-8\'\'report.csv');
  });

  it('percent-encodes unicode in filename* and strips it from ASCII fallback', () => {
    const h = buildContentDisposition('équipe.csv');
    // ASCII fallback replaces non-ASCII with _
    expect(h).toContain('filename="_quipe.csv"');
    // RFC 5987 filename* uses percent-encoding
    expect(h).toContain("filename*=UTF-8''%C3%A9quipe.csv");
  });

  it('handles emoji team names', () => {
    const h = buildContentDisposition('lakers-🏀-season.csv');
    expect(h).toMatch(/filename="lakers-__+-season\.csv"/);
    expect(h).toContain("filename*=UTF-8''lakers-%F0%9F%8F%80-season.csv");
  });

  it('escapes double quotes and backslashes in the ASCII fallback', () => {
    const h = buildContentDisposition('he said "hi"\\there.csv');
    // Quotes and backslash replaced with underscores so the quoted-string form stays valid
    expect(h).toContain('filename="he said _hi__there.csv"');
    // filename* contains the percent-encoded originals
    expect(h).toContain("filename*=UTF-8''");
    expect(h).toContain('%22'); // "
    expect(h).toContain('%5C'); // \
  });

  it('strips CR/LF from the ASCII fallback', () => {
    const h = buildContentDisposition('line1\r\nline2.csv');
    expect(h).toContain('filename="line1__line2.csv"');
  });

  it('falls back to "download" for empty input', () => {
    const h = buildContentDisposition('');
    expect(h).toContain('filename="download"');
  });

  it('percent-encodes RFC 3986 sub-delims that encodeURIComponent leaves alone', () => {
    const h = buildContentDisposition("a'b(c)*!.csv");
    // All of ' ( ) * ! must be percent-encoded per RFC 5987
    expect(h).toContain("filename*=UTF-8''a%27b%28c%29%2A%21.csv");
  });
});
