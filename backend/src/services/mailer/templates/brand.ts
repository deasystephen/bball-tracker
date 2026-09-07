/**
 * The product name as it appears in email copy. Single source for every
 * template — the #431 rename fixed the footers and missed six body lines
 * because each file spelled the name out by hand. `tests/services/mailer.test.ts`
 * asserts no rendered template contains a retired name.
 */
export const APP_NAME = 'Hooplings';
