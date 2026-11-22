import { APP_NAME } from './templates/brand';

/**
 * The `From` header of every message: a display name in front of the sending
 * address, so an inbox shows "Hooplings" (or "Dana Whitfield via Hooplings")
 * instead of the bare no-reply address.
 *
 * `senderName` is the person the message comes from (the coach who invited, the
 * author of an announcement). It is user-supplied text going into a mail
 * header, so it is used only when it is safe and reads as a name:
 *  - control characters and line breaks are removed (no header injection);
 *  - anything containing `@`, `<` or `>` is refused, so a name can never look
 *    like another sender's address (several callers fall back to the person's
 *    email when they have no name);
 *  - it is cut to `MAX_SENDER_NAME_LENGTH` characters.
 * Otherwise the display name is the product name alone. "via Hooplings" stays
 * on every personal form: the message is sent by the app, not from the
 * person's own mailbox.
 */
export const MAX_SENDER_NAME_LENGTH = 40;

/** Longest base64 payload that fits one RFC 2047 encoded-word (75 chars with `=?UTF-8?B?…?=`). */
const ENCODED_WORD_MAX_BYTES = 45;

function cleanSenderName(senderName: string | undefined): string | null {
  if (!senderName) return null;
  // Control characters include CR and LF: none may reach a header.
  const collapsed = senderName
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed || /[@<>]/.test(collapsed)) return null;
  return Array.from(collapsed).slice(0, MAX_SENDER_NAME_LENGTH).join('').trim() || null;
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
