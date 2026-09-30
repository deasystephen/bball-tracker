/**
 * The product name as it appears in email copy. Single source for every
 * template — the #431 rename fixed the footers and missed six body lines
 * because each file spelled the name out by hand. `tests/services/mailer.test.ts`
 * asserts no rendered template contains a retired name.
 */
export const APP_NAME = 'Hooplings';

/**
 * The address people write to, and the `Reply-To` of every message (#450). A
 * mailbox on the apex, read by a person. The sender, `noreply@mail.<domain>`,
 * is on the SES subdomain, whose only MX is the bounce handler: a reply sent
 * there reached nobody.
 */
export const SUPPORT_EMAIL = 'support@hooplings.com';
