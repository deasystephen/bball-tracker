/**
 * Tests for upload-service.
 *
 * Exercises the full presigned-URL upload flow:
 *   1. POST /uploads/avatar-url with correct content type (PNG vs JPEG)
 *   2. fetch(localUri) → blob()
 *   3. PUT to the presigned URL with the blob + content type
 *   4. Returns the public image URL
 */

import { uploadAvatar } from '../../services/upload-service';
import { apiClient } from '../../services/api-client';

type MockedApi = { post: jest.Mock };
const mockedApi = apiClient as unknown as MockedApi;

describe('upload-service', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uploads a JPEG file: requests presigned URL, PUTs blob, returns imageUrl', async () => {
    mockedApi.post.mockResolvedValueOnce({
      data: {
        uploadUrl: 'https://s3.example/presigned?sig=abc',
        imageUrl: 'https://cdn.example/avatars/user-1.jpg',
      },
    });

    const fakeBlob = { type: 'image/jpeg' } as unknown as Blob;
    const fetchMock = jest
      .fn()
      // First call: fetch(localUri) to get the blob.
      .mockResolvedValueOnce({ blob: () => Promise.resolve(fakeBlob) })
      // Second call: PUT to S3.
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await uploadAvatar('file:///tmp/pic.JPG');

    expect(mockedApi.post).toHaveBeenCalledWith('/uploads/avatar-url', {
      contentType: 'image/jpeg',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'file:///tmp/pic.JPG');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://s3.example/presigned?sig=abc', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: fakeBlob,
    });
    expect(result).toBe('https://cdn.example/avatars/user-1.jpg');
  });

  it('detects PNG by file extension (case-insensitive)', async () => {
    mockedApi.post.mockResolvedValueOnce({
      data: {
        uploadUrl: 'https://s3.example/p',
        imageUrl: 'https://cdn.example/a.png',
      },
    });
    const fakeBlob = {} as Blob;
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ blob: () => Promise.resolve(fakeBlob) })
      .mockResolvedValueOnce({ ok: true }) as unknown as typeof fetch;

    await uploadAvatar('file:///tmp/Avatar.PNG');

    expect(mockedApi.post).toHaveBeenCalledWith('/uploads/avatar-url', {
      contentType: 'image/png',
    });
    const putCall = (global.fetch as unknown as jest.Mock).mock.calls[1];
    expect(putCall[1].headers['Content-Type']).toBe('image/png');
  });

  it('propagates errors from the presigned URL request', async () => {
    mockedApi.post.mockRejectedValueOnce(new Error('api down'));
    await expect(uploadAvatar('file:///tmp/pic.jpg')).rejects.toThrow('api down');
  });
});
