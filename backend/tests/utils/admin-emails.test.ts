/**
 * Tests for the admin email allowlist (ADMIN_EMAILS + legacy ADMIN_EMAIL).
 */

import { getAdminEmails, isAdminEmail } from '../../src/utils/admin-emails';

describe('admin-emails', () => {
  const ORIGINAL_ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_EMAILS;
  });

  afterAll(() => {
    if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
    if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
  });

  describe('getAdminEmails', () => {
    it('returns an empty list when neither env var is set', () => {
      expect(getAdminEmails()).toEqual([]);
    });

    it('parses a comma-separated ADMIN_EMAILS list (trimmed, lower-cased)', () => {
      process.env.ADMIN_EMAILS = 'A@Example.com, b@example.com ,C@EXAMPLE.COM';
      expect(getAdminEmails()).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    });

    it('merges legacy ADMIN_EMAIL with ADMIN_EMAILS and de-duplicates', () => {
      process.env.ADMIN_EMAIL = 'owner@example.com';
      process.env.ADMIN_EMAILS = 'owner@example.com,helper@example.com';
      expect(getAdminEmails().sort()).toEqual(['helper@example.com', 'owner@example.com']);
    });

    it('ignores empty entries and stray commas', () => {
      process.env.ADMIN_EMAILS = ',,owner@example.com,, ,';
      expect(getAdminEmails()).toEqual(['owner@example.com']);
    });
  });

  describe('isAdminEmail', () => {
    it('matches an email on the ADMIN_EMAILS list case-insensitively', () => {
      process.env.ADMIN_EMAILS = 'owner@example.com,helper@example.com';
      expect(isAdminEmail('Helper@Example.com')).toBe(true);
      expect(isAdminEmail(' owner@example.com ')).toBe(true);
    });

    it('still honors the legacy single ADMIN_EMAIL', () => {
      process.env.ADMIN_EMAIL = 'owner@example.com';
      expect(isAdminEmail('owner@example.com')).toBe(true);
    });

    it('returns false for non-admin, empty, null, or undefined emails', () => {
      process.env.ADMIN_EMAILS = 'owner@example.com';
      expect(isAdminEmail('someoneelse@example.com')).toBe(false);
      expect(isAdminEmail('')).toBe(false);
      expect(isAdminEmail(null)).toBe(false);
      expect(isAdminEmail(undefined)).toBe(false);
    });

    it('returns false when no allowlist is configured', () => {
      expect(isAdminEmail('owner@example.com')).toBe(false);
    });
  });
});
