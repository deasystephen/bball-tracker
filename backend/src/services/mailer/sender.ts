import { APP_NAME } from './templates/brand';

/**
 * The `From` header of every message: a display name in front of the sending
 * address, so an inbox shows "Hooplings" (or "Dana Whitfield via Hooplings")
 * instead of the bare no-reply address.
 *
 * `senderName` is the person the message comes from (the coach who invited, the
 * author of an announcement). It is user-supplied text going into a mail
 * header, so it is used only when it is safe and reads as a name:
 *  - it is NFKC-normalised first, so a look-alike such as the full-width
 *    commercial at is judged as the character it imitates;
 *  - control characters (line breaks included) and format characters
 *    (zero-width characters, the right-to-left override) are removed: no
 *    header injection, and nothing invisible that reorders the display;
 *  - anything containing `@`, `<` or `>` is refused, so a name can never look
 *    like another sender's address (several callers fall back to the person's
 *    email when they have no name);
 *  - anything containing `=?` is refused: mail clients decode an RFC 2047
 *    encoded-word even inside a quoted string, which would smuggle any of the
 *    above back in;
 *  - it is cut to `MAX_SENDER_NAME_LENGTH` visible characters (grapheme
 *    clusters, so a letter is never parted from its accent).
 * Otherwise the display name is the product name alone. "via Hooplings" stays
 * on every personal form: the message is sent by the app, not from the
 * person's own mailbox (the shared footer says where a reply goes).
 */
export const MAX_SENDER_NAME_LENGTH = 40;

/** Longest base64 payload that fits one RFC 2047 encoded-word (75 chars with `=?UTF-8?B?…?=`). */
const ENCODED_WORD_MAX_BYTES = 45;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function cleanSenderName(senderName: string | undefined): string | null {
  if (!senderName) return null;
  const collapsed = senderName
    .normalize('NFKC')
    // Control characters include CR and LF: none may reach a header.
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\p{Cf}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed || /[@<>]/.test(collapsed) || collapsed.includes('=?')) return null;
  const cut = Array.from(graphemes.segment(collapsed), (part) => part.segment)
    .slice(0, MAX_SENDER_NAME_LENGTH)
    .join('')
    .trim();
  return cut || null;
}

/** The display name alone, before any header encoding. */
export function senderDisplayName(senderName?: string): string {
  const person = cleanSenderName(senderName);
  return person ? `${person} via ${APP_NAME}` : APP_NAME;
}

/** RFC 5322 quoted-string for printable ASCII; RFC 2047 encoded-words (UTF-8, base64) otherwise. */
function encodeDisplayName(displayName: string): string {
  if (/^[\x20-\x7E]*$/.test(displayName)) {
    return `"${displayName.replace(/(["\\])/g, '\\$1')}"`;
  }
  // One encoded-word must hold whole characters, so split on code points.
  const words: string[] = [];
  let chunk = '';
  for (const char of Array.from(displayName)) {
    if (Buffer.byteLength(chunk + char, 'utf8') > ENCODED_WORD_MAX_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join(' ');
}

/** `"Dana Whitfield via Hooplings" <noreply@mail.hooplings.com>` */
export function formatFromAddress(fromAddress: string, senderName?: string): string {
  return `${encodeDisplayName(senderDisplayName(senderName))} <${fromAddress}>`;
}
