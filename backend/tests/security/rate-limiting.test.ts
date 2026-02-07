/**
 * Security tests for rate limiting middleware
 */

import { authRateLimit, apiRateLimit, writeRateLimit } from '../../src/api/middleware/rate-limit';

describe('Rate Limiting Configuration', () => {
  it('should export auth rate limit middleware', () => {
    expect(authRateLimit).toBeDefined();
    expect(typeof authRateLimit).toBe('function');
  });

  it('should export API rate limit middleware', () => {
    expect(apiRateLimit).toBeDefined();
    expect(typeof apiRateLimit).toBe('function');
  });

  it('should export write rate limit middleware', () => {
    expect(writeRateLimit).toBeDefined();
    expect(typeof writeRateLimit).toBe('function');
  });
});
