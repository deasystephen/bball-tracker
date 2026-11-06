/**
 * The real presigned POST policy for an avatar upload (#1005), built by the
 * real `@aws-sdk/s3-presigned-post` (signing is local: no network, static
 * test credentials). Proves the `tagging` field the server adds is in the
 * form fields every client posts AND pinned by the signed policy, so a client
 * cannot drop or change the pending tag. The rest of upload-service is
 * covered in `upload-service.test.ts` with the SDK mocked.
 */

// Static credentials for the default chain, so signing never reaches for a
// profile, SSO or the instance metadata service. Credentials resolve lazily at
// signing time, so setting them here (after the hoisted import) is enough.
// Restored afterwards: process.env is shared with later suites in the worker.
const SAVED_ENV = { ...process.env };
process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-test-secret-test-secret-test';
delete process.env.AWS_PROFILE;
delete process.env.AWS_SESSION_TOKEN;
afterAll(() => {
  process.env = SAVED_ENV;
});

import { generateAvatarUploadUrl, MAX_AVATAR_BYTES, PENDING_TAGGING_XML } from '../../src/services/upload-service';

const USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';

interface Policy {
  expiration: string;
  conditions: unknown[];
}

describe('avatar upload POST policy (real SDK, #1005)', () => {
  it('posts the pending tag set as a form field and pins it exactly in the signed policy', async () => {
    const { fields, uploadUrl, imageUrl } = await generateAvatarUploadUrl(USER_ID, 'image/jpeg');

    expect(fields.tagging).toBe(PENDING_TAGGING_XML);
    expect(fields['Content-Type']).toBe('image/jpeg');
    expect(uploadUrl).toMatch(/^https:\/\//);
    expect(imageUrl).toContain(`/avatars/${USER_ID}/`);

    const policy = JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf8')) as Policy;
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['eq', '$tagging', PENDING_TAGGING_XML],
        { tagging: PENDING_TAGGING_XML },
        ['content-length-range', 1, MAX_AVATAR_BYTES],
        ['eq', '$Content-Type', 'image/jpeg'],
        { key: fields.key },
      ])
    );
    expect(fields['X-Amz-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});
