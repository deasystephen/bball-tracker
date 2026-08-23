/**
 * Tests for upload-service.
 *
 * Exercises the full presigned-POST upload flow:
 *   1. fetch(localUri) → blob() (size check)
 *   2. POST /uploads/avatar-url with content type + length
 *   3. multipart POST to S3 with the policy fields + file part
 *   4. Returns the public image URL — or throws when S3 rejects the upload
 *      (audit #39: a failed upload must never persist a dangling URL).
 */

import { uploadAvatar, MAX_AVATAR_BYTES } from '../../services/upload-service';
import { apiClient } from '../../services/api-client';

type MockedApi = { post: jest.Mock };
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));

const mockedApi = apiClient as unknown as MockedApi;

const PRESIGNED = {
  uploadUrl: 'https://s3.example/bucket',
  fields: { key: 'avatars/user-1/x.jpg', Policy: 'p', 'X-Amz-Signature': 's' },
  imageUrl: 'https://cdn.example/avatars/user-1.jpg',
};

/**
 * React Native's FormData keeps `{ uri, name, type }` parts as objects for the
 * native uploader; the jest environment's FormData would stringify them, so
 * record the parts ourselves.
 */
class FakeFormData {
  parts: [string, unknown][] = [];
  append(name: string, value: unknown): void {
    this.parts.push([name, value]);
  }
}

function formEntries(form: unknown): [string, unknown][] {
  return (form as FakeFormData).parts;
}

describe('upload-service', () => {
  const originalFetch = global.fetch;
  const originalFormData = global.FormData;

  beforeEach(() => {
    jest.clearAllMocks();
    global.FormData = FakeFormData as unknown as typeof FormData;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.FormData = originalFormData;
  });

  it('uploads a JPEG: reads the blob, requests a POST policy, posts the form, returns imageUrl', async () => {
    mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });

    const fakeBlob = { type: 'image/jpeg', size: 1234 } as unknown as Blob;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ blob: () => Promise.resolve(fakeBlob) })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await uploadAvatar('file:///tmp/pic.JPG');

    expect(mockedApi.post).toHaveBeenCalledWith('/uploads/avatar-url', {
      contentType: 'image/jpeg',
      contentLength: 1234,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'file:///tmp/pic.JPG');

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://s3.example/bucket');
    expect(init.method).toBe('POST');
    const entries = formEntries(init.body as FormData);
    expect(entries).toEqual(
      expect.arrayContaining([
        ['key', 'avatars/user-1/x.jpg'],
        ['Policy', 'p'],
        ['X-Amz-Signature', 's'],
      ])
    );
    // The file part must come last and describe the local file for RN's uploader.
    const [lastName, lastValue] = entries[entries.length - 1];
    expect(lastName).toBe('file');
    expect(lastValue).toEqual(
      expect.objectContaining({ uri: 'file:///tmp/pic.JPG', type: 'image/jpeg', name: 'avatar.jpg' })
    );
    expect(result).toBe('https://cdn.example/avatars/user-1.jpg');
  });

  it('detects PNG by file extension (case-insensitive)', async () => {
    mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });
    const fakeBlob = { size: 10 } as Blob;
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ blob: () => Promise.resolve(fakeBlob) })
      .mockResolvedValueOnce({ ok: true, status: 204 }) as unknown as typeof fetch;

    await uploadAvatar('file:///tmp/Avatar.PNG');

    expect(mockedApi.post).toHaveBeenCalledWith('/uploads/avatar-url', {
      contentType: 'image/png',
      contentLength: 10,
    });
    const init = (global.fetch as unknown as jest.Mock).mock.calls[1][1];
    const entries = formEntries(init.body as FormData);
    expect(entries[entries.length - 1][1]).toEqual(expect.objectContaining({ type: 'image/png', name: 'avatar.png' }));
  });

  it('throws when S3 rejects the upload and never returns the image URL', async () => {
    mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ blob: () => Promise.resolve({ size: 10 } as Blob) })
      .mockResolvedValueOnce({ ok: false, status: 403 }) as unknown as typeof fetch;

    await expect(uploadAvatar('file:///tmp/pic.jpg')).rejects.toThrow('Avatar upload failed (403)');
  });

  it('includes the S3 error code and message when the policy rejects the upload', async () => {
    mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ blob: () => Promise.resolve({ size: 10 } as Blob) })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            '<?xml version="1.0"?><Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>'
          ),
      }) as unknown as typeof fetch;

    await expect(uploadAvatar('file:///tmp/pic.jpg')).rejects.toThrow(
      'Avatar upload failed (400 EntityTooLarge: Your proposed upload exceeds the maximum allowed size)'
    );
  });

  it('rejects oversize files locally before asking for a policy', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ blob: () => Promise.resolve({ size: MAX_AVATAR_BYTES + 1 } as Blob) }) as unknown as typeof fetch;

    await expect(uploadAvatar('file:///tmp/huge.jpg')).rejects.toThrow('5 MB or smaller');
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it('propagates errors from the presigned URL request', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ blob: () => Promise.resolve({ size: 10 } as Blob) }) as unknown as typeof fetch;
    mockedApi.post.mockRejectedValueOnce(new Error('api down'));
    await expect(uploadAvatar('file:///tmp/pic.jpg')).rejects.toThrow('api down');
  });
});
