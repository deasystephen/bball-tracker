import { apiBaseUrl, publicAppUrl, warnMissingUrlConfig, DEFAULT_BASE_URL, URL_ENV_VARS } from '../../src/utils/urls';

describe('utils/urls (domain migration PR2, D10)', () => {
  describe('publicAppUrl / apiBaseUrl', () => {
    it('return the env value with trailing slashes stripped', () => {
      const env = { PUBLIC_APP_URL: 'https://app.example.test/', API_BASE_URL: 'https://api.example.test//' };
      expect(publicAppUrl(env)).toBe('https://app.example.test');
      expect(apiBaseUrl(env)).toBe('https://api.example.test');
    });

    it('fall back to localhost when unset or blank — never to a brand domain', () => {
      expect(publicAppUrl({})).toBe(DEFAULT_BASE_URL);
      expect(apiBaseUrl({ API_BASE_URL: '   ' })).toBe(DEFAULT_BASE_URL);
      expect(DEFAULT_BASE_URL).toBe('http://localhost:3000');
    });

    it('read only their own variable', () => {
      const env = { PUBLIC_APP_URL: 'https://app.example.test' };
      expect(apiBaseUrl(env)).toBe(DEFAULT_BASE_URL);
      expect(publicAppUrl({ API_BASE_URL: 'https://api.example.test' })).toBe(DEFAULT_BASE_URL);
    });

    it('default to process.env when no env is passed', () => {
      const previous = process.env.PUBLIC_APP_URL;
      process.env.PUBLIC_APP_URL = 'https://from-process.example.test/';
      try {
        expect(publicAppUrl()).toBe('https://from-process.example.test');
      } finally {
        if (previous === undefined) delete process.env.PUBLIC_APP_URL;
        else process.env.PUBLIC_APP_URL = previous;
      }
    });
  });

  describe('warnMissingUrlConfig', () => {
    const log = { warn: jest.fn() };
    beforeEach(() => log.warn.mockClear());

    it('reports every unset var and warns once per var in production', () => {
      const missing = warnMissingUrlConfig({ NODE_ENV: 'production' }, log);
      expect(missing).toEqual([...URL_ENV_VARS]);
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('PUBLIC_APP_URL'), { envVar: 'PUBLIC_APP_URL' });
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('API_BASE_URL'), { envVar: 'API_BASE_URL' });
    });

    it('treats a blank value as unset', () => {
      const missing = warnMissingUrlConfig({ NODE_ENV: 'production', PUBLIC_APP_URL: '  ', API_BASE_URL: 'https://api.example.test' }, log);
      expect(missing).toEqual(['PUBLIC_APP_URL']);
      expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('is silent when both are set', () => {
      expect(warnMissingUrlConfig({ NODE_ENV: 'production', PUBLIC_APP_URL: 'https://a.example.test', API_BASE_URL: 'https://b.example.test' }, log)).toEqual([]);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('still reports but does not warn outside production', () => {
      expect(warnMissingUrlConfig({ NODE_ENV: 'test' }, log)).toEqual([...URL_ENV_VARS]);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });
});
