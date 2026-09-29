import { deployedCommit } from '../../src/utils/release';

const COMMIT = 'e87ed33577de095449591fc2ca47640fea8520ce';

describe('deployedCommit', () => {
  it('returns the commit the deploy job wrote into SENTRY_RELEASE', () => {
    expect(deployedCommit({ SENTRY_RELEASE: COMMIT })).toBe(COMMIT);
  });

  it('ignores surrounding whitespace', () => {
    expect(deployedCommit({ SENTRY_RELEASE: ` ${COMMIT}\n` })).toBe(COMMIT);
  });

  it('is null when the variable is unset or blank (local development, tests)', () => {
    expect(deployedCommit({})).toBeNull();
    expect(deployedCommit({ SENTRY_RELEASE: '' })).toBeNull();
    expect(deployedCommit({ SENTRY_RELEASE: '   ' })).toBeNull();
  });

  it('is null when the placeholder was never replaced', () => {
    expect(deployedCommit({ SENTRY_RELEASE: 'SENTRY_RELEASE_PLACEHOLDER' })).toBeNull();
  });

  it('is null for anything that is not a full commit id', () => {
    expect(deployedCommit({ SENTRY_RELEASE: 'e87ed33' })).toBeNull();
    expect(deployedCommit({ SENTRY_RELEASE: 'backend@1.5.0' })).toBeNull();
    expect(deployedCommit({ SENTRY_RELEASE: COMMIT.toUpperCase() })).toBeNull();
    expect(deployedCommit({ SENTRY_RELEASE: `${COMMIT}0` })).toBeNull();
  });

  it('reads process.env by default', () => {
    const previous = process.env.SENTRY_RELEASE;
    process.env.SENTRY_RELEASE = COMMIT;
    try {
      expect(deployedCommit()).toBe(COMMIT);
    } finally {
      if (previous === undefined) delete process.env.SENTRY_RELEASE;
      else process.env.SENTRY_RELEASE = previous;
    }
  });
});
