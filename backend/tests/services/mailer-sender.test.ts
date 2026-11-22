/**
 * The `From` display name (`services/mailer/sender.ts`): user-supplied names go
 * into a mail header, so the cases that matter are the unsafe ones.
 */
import { MAX_SENDER_NAME_LENGTH, formatFromAddress, senderDisplayName } from '../../src/services/mailer/sender';

const ADDRESS = 'noreply@mail.example.test';

/** Decode the RFC 2047 encoded-words of a header value back to text. */
function decodeWords(header: string): string {
  return header
    .split(' ')
    .map((word) => {
      const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word);
      if (!match) throw new Error(`not an encoded-word: ${word}`);
      return Buffer.from(match[1], 'base64').toString('utf8');
    })
    .join('');
}

describe('formatFromAddress', () => {
  it('is the product name when no person is given', () => {
    expect(formatFromAddress(ADDRESS)).toBe('"Hooplings" <noreply@mail.example.test>');
    expect(formatFromAddress(ADDRESS, '')).toBe('"Hooplings" <noreply@mail.example.test>');
    expect(formatFromAddress(ADDRESS, '   ')).toBe('"Hooplings" <noreply@mail.example.test>');
  });

  it('names the person, always "via" the product', () => {
    expect(formatFromAddress(ADDRESS, 'Dana Whitfield')).toBe('"Dana Whitfield via Hooplings" <noreply@mail.example.test>');
  });

  it('never lets a name add a header: line breaks and control characters become spaces', () => {
    const from = formatFromAddress(ADDRESS, 'Dana\r\nBcc: victim@example.test');
    // The "@" makes it unusable as a name at all, so it falls back.
    expect(from).toBe('"Hooplings" <noreply@mail.example.test>');
    expect(formatFromAddress(ADDRESS, 'Dana\r\n\tWhitfield\u0000')).toBe(
      '"Dana Whitfield via Hooplings" <noreply@mail.example.test>'
    );
  });

  it('refuses a name that could read as another address (callers fall back to an email when there is no name)', () => {
    for (const name of ['coach@example.test', 'Support <support@hooplings.com>', 'a>b', 'a<b']) {
      expect(senderDisplayName(name)).toBe('Hooplings');
    }
  });

  it('refuses look-alikes of those characters, judged after normalisation', () => {
    // Full-width and small-form commercial at, full-width angle brackets.
    for (const name of ['support\uFF20hooplings.com', 'support\uFE6Bhooplings.com', '\uFF1Cb\uFF1E']) {
      expect(senderDisplayName(name)).toBe('Hooplings');
    }
  });

  it('refuses an RFC 2047 encoded-word typed as a name (clients decode it inside quotes)', () => {
    for (const name of ['=?UTF-8?Q?support=40hooplings.com?=', 'Dana =?UTF-8?B?QGV2aWw=?=']) {
      expect(formatFromAddress(ADDRESS, name)).toBe('"Hooplings" <noreply@mail.example.test>');
    }
  });

  it('removes invisible format characters: no right-to-left override, no zero-width padding', () => {
    expect(senderDisplayName('Dana\u202E Whit\u200Bfield\u2066')).toBe('Dana Whitfield via Hooplings');
  });

  it('escapes quotes and backslashes inside the quoted name', () => {
    expect(formatFromAddress(ADDRESS, 'Dana "Coach" W\\')).toBe(
      '"Dana \\"Coach\\" W\\\\ via Hooplings" <noreply@mail.example.test>'
    );
  });

  it('cuts a very long name on a whole visible character', () => {
    const long = 'é'.repeat(MAX_SENDER_NAME_LENGTH + 20);
    expect(senderDisplayName(long)).toBe(`${'é'.repeat(MAX_SENDER_NAME_LENGTH)} via Hooplings`);

    // A base letter and a combining mark that has no precomposed form stay together.
    const cluster = 'q\u0303';
    const cut = senderDisplayName(cluster.repeat(MAX_SENDER_NAME_LENGTH + 5));
    expect(cut).toBe(`${cluster.repeat(MAX_SENDER_NAME_LENGTH)} via Hooplings`);
  });

  it('encodes a non-ASCII name as UTF-8 encoded-words that each fit a header line and decode back', () => {
    const name = 'José Ángel Hernández Núñez-Íñiguez';
    const from = formatFromAddress(ADDRESS, name);
    expect(from.endsWith(` <${ADDRESS}>`)).toBe(true);
    const header = from.slice(0, -` <${ADDRESS}>`.length);
    expect(/^[\x20-\x7E]+$/.test(header)).toBe(true);
    for (const word of header.split(' ')) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeWords(header)).toBe(`${name} via Hooplings`);
  });

  it('keeps an emoji or other astral character whole across encoded-words', () => {
    const name = '🏀'.repeat(20);
    const header = formatFromAddress(ADDRESS, name).slice(0, -` <${ADDRESS}>`.length);
    expect(decodeWords(header)).toBe(`${name} via Hooplings`);
  });
});
