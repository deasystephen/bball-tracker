/**
 * Schema tests for POST /teams/:teamId/announcements (#693): title and body
 * are required, capped at 200 and 5000 characters.
 */

import { createAnnouncementSchema } from '../../src/api/teams/schemas';

const VALID = { title: 'Practice moved', body: 'Thursday practice starts at 6pm.' };

describe('createAnnouncementSchema', () => {
  it('accepts a title and body at their caps', () => {
    const result = createAnnouncementSchema.safeParse({ title: 'T'.repeat(200), body: 'B'.repeat(5000) });
    expect(result.success).toBe(true);
  });

  it('accepts a one-character title and body', () => {
    expect(createAnnouncementSchema.safeParse({ title: 'T', body: 'B' }).success).toBe(true);
  });

  it.each([
    ['a missing title', { body: VALID.body }],
    ['a missing body', { title: VALID.title }],
    ['an empty title', { ...VALID, title: '' }],
    ['an empty body', { ...VALID, body: '' }],
    ['a 201-character title', { ...VALID, title: 'T'.repeat(201) }],
    ['a 5001-character body', { ...VALID, body: 'B'.repeat(5001) }],
    ['a non-string title', { ...VALID, title: 7 }],
  ])('rejects %s', (_label, body) => {
    expect(createAnnouncementSchema.safeParse(body).success).toBe(false);
  });
});
