/**
 * The WorkOS client is built on first use, so importing the module (the
 * database seed does, transitively) needs no WorkOS environment.
 */

type WorkOSClientModule = typeof import('../../src/utils/workos-client');

const SAVED = { key: process.env.WORKOS_API_KEY, id: process.env.WORKOS_CLIENT_ID };

function loadActual(): WorkOSClientModule {
  let mod: WorkOSClientModule | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<WorkOSClientModule>('../../src/utils/workos-client');
  });
  return mod as WorkOSClientModule;
}

describe('workos-client', () => {
  afterEach(() => {
    if (SAVED.key === undefined) delete process.env.WORKOS_API_KEY;
    else process.env.WORKOS_API_KEY = SAVED.key;
    if (SAVED.id === undefined) delete process.env.WORKOS_CLIENT_ID;
    else process.env.WORKOS_CLIENT_ID = SAVED.id;
  });

  it('imports without WORKOS_API_KEY or WORKOS_CLIENT_ID', () => {
    delete process.env.WORKOS_API_KEY;
    delete process.env.WORKOS_CLIENT_ID;
    expect(() => loadActual()).not.toThrow();
  });

  it('throws at call time when the API key is unset', () => {
    delete process.env.WORKOS_API_KEY;
    process.env.WORKOS_CLIENT_ID = 'client_unit';
    expect(() => loadActual().getWorkOS()).toThrow('WORKOS_API_KEY environment variable is required');
  });

  it('throws at call time when the client id is unset', () => {
    process.env.WORKOS_API_KEY = 'sk_test_unit';
    delete process.env.WORKOS_CLIENT_ID;
    expect(() => loadActual().getWorkOSClientId()).toThrow('WORKOS_CLIENT_ID environment variable is required');
  });

  it('builds one client and derives the JWKS from the client id', () => {
    process.env.WORKOS_API_KEY = 'sk_test_unit';
    process.env.WORKOS_CLIENT_ID = 'client_unit';
    const mod = loadActual();
    expect(mod.getWorkOS()).toBe(mod.getWorkOS());
    expect(mod.getWorkOSClientId()).toBe('client_unit');
    process.env.WORKOS_CLIENT_ID = 'client_changed_later';
    expect(mod.getWorkOSClientId()).toBe('client_unit');
    expect(mod.getWorkOSJwks()).toBe(mod.getWorkOSJwks());
  });

  it('getWorkOSJwks throws the client id error when only the API key is set', () => {
    process.env.WORKOS_API_KEY = 'sk_test_unit';
    delete process.env.WORKOS_CLIENT_ID;
    expect(() => loadActual().getWorkOSJwks()).toThrow('WORKOS_CLIENT_ID environment variable is required');
  });

  it('assertWorkOSConfig throws when either variable is missing', () => {
    process.env.WORKOS_API_KEY = 'sk_test_unit';
    delete process.env.WORKOS_CLIENT_ID;
    expect(() => loadActual().assertWorkOSConfig()).toThrow('WORKOS_CLIENT_ID');
    delete process.env.WORKOS_API_KEY;
    process.env.WORKOS_CLIENT_ID = 'client_unit';
    expect(() => loadActual().assertWorkOSConfig()).toThrow('WORKOS_API_KEY');
    try {
      loadActual().assertWorkOSConfig();
    } catch (error) {
      expect((error as { variable?: string }).variable).toBe('WORKOS_API_KEY');
    }
    process.env.WORKOS_API_KEY = 'sk_test_unit';
    expect(() => loadActual().assertWorkOSConfig()).not.toThrow();
  });
});
