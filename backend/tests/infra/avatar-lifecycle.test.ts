/**
 * Config-bound test over pending avatar expiry (#1005).
 *
 * Three places must agree, and a mismatch fails quietly in production:
 *   - `upload-service.ts` tags every upload `pending=true` (the POST policy);
 *   - `infra/s3.tf` expires objects carrying that exact tag;
 *   - `infra/ecs.tf` lets the task role set the tag at upload
 *     (s3:PutObjectTagging, checked on the presign signer), remove it on
 *     save (s3:DeleteObjectTagging), and list the bucket with no condition
 *     (s3:ListBucket, so a missing key is NoSuchKey rather than AccessDenied).
 * A wrong tag in the rule expires nothing; a missing IAM action fails every
 * upload (PutObjectTagging) or every save (DeleteObjectTagging), and without
 * ListBucket an expired upload is a 5xx instead of 400 `upload_expired`.
 */
import path from 'path';
import { PENDING_TAG_KEY, PENDING_TAG_VALUE } from '../../src/services/upload-service';
import { resourceBlock } from './terraform';

const ROOT = path.resolve(__dirname, '../../..');
const lifecycle = resourceBlock(
  path.join(ROOT, 'infra/s3.tf'),
  'aws_s3_bucket_lifecycle_configuration',
  'avatars'
);
const taskPolicy = resourceBlock(path.join(ROOT, 'infra/ecs.tf'), 'aws_iam_role_policy', 'ecs_task_s3_avatars');

/** The text of the `rule { … }` whose id is `id`. */
function rule(id: string): string {
  const rules = lifecycle.split(/\n\s*rule\s*\{/).slice(1);
  const found = rules.find((r) => new RegExp(`id\\s*=\\s*"${id}"`).test(r));
  if (!found) throw new Error(`infra/s3.tf: no lifecycle rule "${id}"`);
  return found;
}

describe('pending avatar expiry (#1005)', () => {
  it('expires objects tagged exactly as upload-service tags them, under avatars/, after 3 days', () => {
    const expire = rule('expire-pending-avatars');
    expect(expire).toMatch(/status\s*=\s*"Enabled"/);
    expect(expire).toMatch(/prefix\s*=\s*"avatars\/"/);
    expect(expire).toMatch(new RegExp(`${PENDING_TAG_KEY}\\s*=\\s*"${PENDING_TAG_VALUE}"`));
    expect(expire).toMatch(/expiration\s*\{\s*days\s*=\s*3\s*\}/);
  });

  it('keeps the abort-incomplete-multipart rule alongside it', () => {
    const abort = rule('abort-incomplete-avatar-uploads');
    expect(abort).toMatch(/days_after_initiation\s*=\s*1/);
  });

  it('lets the task role tag uploads and untag them on save', () => {
    expect(taskPolicy).toContain('"s3:PutObjectTagging"');
    expect(taskPolicy).toContain('"s3:DeleteObjectTagging"');
    expect(taskPolicy).toContain('${aws_s3_bucket.avatars.arn}/*');
  });

  it('lets the task role list the bucket with no condition, so a missing key is NoSuchKey, not AccessDenied', () => {
    const statement = /\{[^{}]*"s3:ListBucket"[^{}]*\}/.exec(taskPolicy);
    expect(statement).not.toBeNull();
    const text = statement![0];
    // On the bucket itself (ListBucket is a bucket action), not the objects.
    expect(text).toMatch(/Resource\s*=\s*aws_s3_bucket\.avatars\.arn\s/);
    // An object-level request carries no s3:prefix key, so any condition here
    // would keep the grant from ever applying to it.
    expect(text).not.toMatch(/Condition/);
  });
});
