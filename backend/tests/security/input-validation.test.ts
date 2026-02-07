/**
 * Security tests for input validation and route parameter sanitization
 */

import { validateUuidParams } from '../../src/api/middleware/validate-params';
import { Request, Response, NextFunction } from 'express';

describe('UUID Parameter Validation Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = { params: {} };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
  });

  it('should pass valid UUID params', () => {
    mockReq.params = { id: '550e8400-e29b-41d4-a716-446655440000' };
    const middleware = validateUuidParams('id');
    middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
    expect(mockNext.mock.calls[0][0]).toBeUndefined();
  });

  it('should reject non-UUID strings', () => {
    mockReq.params = { id: 'not-a-uuid' };
    const middleware = validateUuidParams('id');
    middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
    const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(400);
  });

  it('should reject SQL injection attempts in params', () => {
    mockReq.params = { id: "'; DROP TABLE users; --" };
    const middleware = validateUuidParams('id');
    middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
    const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(400);
  });

  it('should reject path traversal attempts in params', () => {
    mockReq.params = { id: '../../../etc/passwd' };
    const middleware = validateUuidParams('id');
    middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
    const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(400);
  });

  it('should validate multiple params', () => {
    mockReq.params = {
      gameId: '550e8400-e29b-41d4-a716-446655440000',
      eventId: 'not-valid',
    };
    const middleware = validateUuidParams('gameId', 'eventId');
    middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
    const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(400);
  });

  it('should pass when multiple params are all valid UUIDs', () => {
    mockReq.params = {
      gameId: '550e8400-e29b-41d4-a716-446655440000',
      eventId: '660e8400-e29b-41d4-a716-446655440001',
    };
    const middleware = validateUuidParams('gameId', 'eventId');
    middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
    expect(mockNext.mock.calls[0][0]).toBeUndefined();
  });

  it('should handle empty string params', () => {
    mockReq.params = { id: '' };
    const middleware = validateUuidParams('id');
    middleware(mockReq as Request, mockRes as Response, mockNext);
    // Empty string should pass (the param is falsy, so the check is skipped)
    expect(mockNext).toHaveBeenCalled();
  });

  it('should reject UUIDs with extra characters', () => {
    mockReq.params = { id: '550e8400-e29b-41d4-a716-446655440000; DROP TABLE' };
    const middleware = validateUuidParams('id');
    middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
    const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(400);
  });
});
