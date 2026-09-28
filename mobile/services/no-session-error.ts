/**
 * The error a request fails with when it needs a session and there is none
 * (#582). Thrown by the api-client's request interceptor INSTEAD of sending:
 * the server could only answer 401, and when a session has just ended every
 * query still on screen would ask. Nothing reaches the network.
 *
 * Its own module, free of imports with side effects, so the query client can
 * recognise it without importing the api-client (which test suites mock).
 */

import type { InternalAxiosRequestConfig } from 'axios';

export const NO_SESSION_CODE = 'ERR_NO_SESSION';

export class NoSessionError extends Error {
  readonly code = NO_SESSION_CODE;
  readonly config: InternalAxiosRequestConfig;

  constructor(config: InternalAxiosRequestConfig) {
    super('You are signed out');
    this.name = 'NoSessionError';
    this.config = config;
  }
}

export const isNoSessionError = (error: unknown): error is NoSessionError =>
  error instanceof NoSessionError;
