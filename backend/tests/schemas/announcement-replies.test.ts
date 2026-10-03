/**
 * Schema tests for the announcement reply routes (#34).
 */

import { createReplySchema, replyQuerySchema } from '../../src/api/announcements/schemas';

describe('createReplySchema', () => {
  it('accepts a plain body and trims it', () => {
    const result = createReplySchema.safeParse({ body: '  See you there  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ body: 'See you there' });
  });

  it('rejects a missing, empty or whitespace-only body', () => {
    expect(createReplySchema.safeParse({}).success).toBe(false);
    expect(createReplySchema.safeParse({ body: '' }).success).toBe(false);
    expect(createReplySchema.safeParse({ body: '   ' }).success).toBe(false);
  });

  it('caps the body at 2000 characters', () => {
    expect(createReplySchema.safeParse({ body: 'x'.repeat(2000) }).success).toBe(true);
    expect(createReplySchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('rejects a non-string body', () => {
    expect(createReplySchema.safeParse({ body: 42 }).success).toBe(false);
  });
});

describe('replyQuerySchema', () => {
  it('defaults to 20 per page from offset 0', () => {
    const result = replyQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ limit: 20, offset: 0 });
  });

  it('coerces numeric strings', () => {
    const result = replyQuerySchema.safeParse({ limit: '5', offset: '40' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ limit: 5, offset: 40 });
  });

  it('rejects limit 0, limit above 100, a negative offset and fractions', () => {
    expect(replyQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(replyQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(replyQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
    expect(replyQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false);
    expect(replyQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
  });
});
