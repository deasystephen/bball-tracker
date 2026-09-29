/**
 * Tests for upload-service.
 *
 * Exercises the full presigned-POST upload flow:
 *   1. open the local file (size check)
 *   2. POST /uploads/avatar-url with content type + length
 *   3. multipart POST to S3 with the policy fields + file part
 *   4. Returns the public image URL — or throws when S3 rejects the upload
 *      (audit #39: a failed upload must never persist a dangling URL).
 *
 * The last block runs the form through the encoder Expo's `fetch` really uses.
 * Build #33 (Expo SDK 57) failed every upload there, and no test noticed,
 * because every test stubbed `fetch` and never encoded the body (#576).
 */

import { uploadAvatar, MAX_AVATAR_BYTES } from '../../services/upload-service';
import { apiClient } from '../../services/api-client';

type MockedApi = { post: jest.Mock };
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));

interface MockLocalFile {
  size: number;
  exists?: boolean;
  type?: string;
  bytes?: number[];
}

const mockLocalFiles = new Map<string, MockLocalFile>();

jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    name: string;
    exists: boolean;
    size: number;
    type: string;
    private readonly content: number[];

    constructor(uri: string) {
      const found = mockLocalFiles.get(uri);
      this.uri = uri;
      this.name = uri.slice(uri.lastIndexOf('/') + 1);
      this.exists = found ? found.exists !== false : false;
      this.size = found && this.exists ? found.size : 0;
      this.type = found?.type ?? '';
      this.content = found?.bytes ?? [];
    }

    bytes(): Promise<Uint8Array> {
      return Promise.resolve(Uint8Array.from(this.content));
    }
  },
}));

const mockedApi = apiClient as unknown as MockedApi;

const PRESIGNED = {
  uploadUrl: 'https://s3.example/bucket',
  fields: { key: 'avatars/user-1/x.jpg', Policy: 'p', 'X-Amz-Signature': 's' },
  imageUrl: 'https://cdn.example/avatars/user-1.jpg',
};

/**
 * The jest environment's FormData would stringify a file part, so record the
 * parts ourselves. `entries()` is what Expo's encoder reads.
 */
class FakeFormData {
  parts: [string, unknown][] = [];
  append(name: string, value: unknown): void {
    this.parts.push([name, value]);
  }
  entries(): [string, unknown][] {
    return this.parts;
  }
}

function formEntries(form: unknown): [string, unknown][] {
  return (form as FakeFormData).parts;
}

function stubUpload(response: unknown): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValueOnce(response);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('upload-service', () => {
  const originalFetch = global.fetch;
  const originalFormData = global.FormData;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLocalFiles.clear();
    global.FormData = FakeFormData as unknown as typeof FormData;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.FormData = originalFormData;
  });

  it('uploads a JPEG: opens the file, requests a POST policy, posts the form, returns imageUrl', async () => {
    mockLocalFiles.set('file:///tmp/pic.JPG', { size: 1234, type: 'image/jpeg' });
    mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });
    const fetchMock = stubUpload({ ok: true, status: 204 });

    const result = await uploadAvatar('file:///tmp/pic.JPG');

    expect(mockedApi.post).toHaveBeenCalledWith('/uploads/avatar-url', {
      contentType: 'image/jpeg',
      contentLength: 1234,
    });

    // One network call only: the local file is never read through fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://s3.example/bucket');
    expect(init.method).toBe('POST');
    const entries = formEntries(init.body as FormData);
    expect(entries.slice(0, -1)).toEqual([
      ['key', 'avatars/user-1/x.jpg'],
      ['Policy', 'p'],
      ['X-Amz-Signature', 's'],
    ]);
    // The file part must come last, and must be the file itself.
    const [lastName, lastValue] = entries[entries.length - 1];
    expect(lastName).toBe('file');
    expect(lastValue).toEqual(
      expect.objectContaining({ uri: 'file:///tmp/pic.JPG', name: 'pic.JPG', size: 1234 })
    );
    expect(result).toBe('https://cdn.example/avatars/user-1.jpg');
  });

  it('detects PNG by file extension (case-insensitive)', async () => {
    mockLocalFiles.set('file:///tmp/Avatar.PNG', { size: 10, type: 'image/png' });
    mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });
    stubUpload({ ok: true, status: 204 });

    await uploadAvatar('file:///tmp/Avatar.PNG');

    expect(mockedApi.post).toHaveBeenCalledWith('/uploads/avatar-url', {
      contentType: 'image/png',
      contentLength: 10,
    });
  });

  it('throws when S3 rejects the upload and never returns the image URL', async () => {
    mockLocalFiles.set('file:///tmp/pic.jpg', { size: 10 });
    mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });
    stubUpload({ ok: false, status: 403 });

    await expect(uploadAvatar('file:///tmp/pic.jpg')).rejects.toThrow('Avatar upload failed (403)');
  });

  it('includes the S3 error code and message when the policy rejects the upload', async () => {
    mockLocalFiles.set('file:///tmp/pic.jpg', { size: 10 });
    mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });
    stubUpload({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          '<?xml version="1.0"?><Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>'
        ),
    });

    await expect(uploadAvatar('file:///tmp/pic.jpg')).rejects.toThrow(
      'Avatar upload failed (400 EntityTooLarge: Your proposed upload exceeds the maximum allowed size)'
    );
  });

  it('rejects oversize files locally before asking for a policy', async () => {
    mockLocalFiles.set('file:///tmp/huge.jpg', { size: MAX_AVATAR_BYTES + 1 });
    const fetchMock = stubUpload({ ok: true, status: 204 });

    await expect(uploadAvatar('file:///tmp/huge.jpg')).rejects.toThrow('5 MB or smaller');
    expect(mockedApi.post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a file of exactly the maximum size', async () => {
    mockLocalFiles.set('file:///tmp/max.jpg', { size: MAX_AVATAR_BYTES });
    mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });
    stubUpload({ ok: true, status: 204 });

    await expect(uploadAvatar('file:///tmp/max.jpg')).resolves.toBe(PRESIGNED.imageUrl);
  });

  it.each([
    ['a file that does not exist', 'file:///tmp/gone.jpg', undefined],
    ['a file that cannot be opened', 'file:///tmp/locked.jpg', { size: 50, exists: false }],
    ['an empty file', 'file:///tmp/empty.jpg', { size: 0 }],
  ])('rejects %s before asking for a policy', async (_label, uri, file) => {
    if (file) mockLocalFiles.set(uri, file);
    const fetchMock = stubUpload({ ok: true, status: 204 });

    await expect(uploadAvatar(uri)).rejects.toThrow('The selected image could not be read');
    expect(mockedApi.post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates errors from the presigned URL request', async () => {
    mockLocalFiles.set('file:///tmp/pic.jpg', { size: 10 });
    const fetchMock = stubUpload({ ok: true, status: 204 });
    mockedApi.post.mockRejectedValueOnce(new Error('api down'));

    await expect(uploadAvatar('file:///tmp/pic.jpg')).rejects.toThrow('api down');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("with the encoder Expo's fetch uses", () => {
    type ConvertFormData = (
      form: FormData,
      boundary?: string
    ) => Promise<{ body: Uint8Array; boundary: string }>;

    // Loaded with requireActual, not imported: it is Expo's source file and
    // must not be pulled into this project's type check.
    const { convertFormDataAsync } = jest.requireActual<{ convertFormDataAsync: ConvertFormData }>(
      'expo/src/winter/fetch/convertFormData'
    );

    const decode = (body: Uint8Array): string =>
      Array.from(body, (byte) => String.fromCharCode(byte)).join('');

    it('encodes the form uploadAvatar builds, file bytes included', async () => {
      // "JPG!" — four bytes that would be mangled by any text conversion.
      const bytes = [0xff, 0xd8, 0x4a, 0x21];
      mockLocalFiles.set('file:///tmp/pic.jpg', { size: bytes.length, type: 'image/jpeg', bytes });
      mockedApi.post.mockResolvedValueOnce({ data: PRESIGNED });
      const fetchMock = stubUpload({ ok: true, status: 204 });

      await uploadAvatar('file:///tmp/pic.jpg');

      const form = fetchMock.mock.calls[0][1].body as FormData;
      const { body } = await convertFormDataAsync(form, 'BOUNDARY');
      const text = decode(body);

      const parts = text.split('--BOUNDARY').slice(1, -1);
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe(
        '\r\ncontent-disposition: form-data; name="key"\r\n\r\navatars/user-1/x.jpg\r\n'
      );
      // S3 ignores every field after the file, so it has to be the last part.
      expect(parts[3]).toBe(
        '\r\ncontent-disposition: form-data; name="file"; filename="pic.jpg"\r\n' +
          'content-type: image/jpeg\r\n\r\n' +
          String.fromCharCode(...bytes) +
          '\r\n'
      );
      expect(text.endsWith('--BOUNDARY--\r\n')).toBe(true);
    });

    it("refuses React Native's { uri, name, type } part, which is what build #33 sent", async () => {
      const form = new FakeFormData();
      form.append('key', 'avatars/user-1/x.jpg');
      form.append('file', { uri: 'file:///tmp/pic.jpg', name: 'avatar.jpg', type: 'image/jpeg' });

      await expect(convertFormDataAsync(form as unknown as FormData)).rejects.toThrow(
        'Unsupported FormDataPart implementation'
      );
    });
  });
});
