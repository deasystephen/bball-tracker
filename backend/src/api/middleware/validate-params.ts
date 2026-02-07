/**
 * Middleware for validating route parameters
 */

import { Request, Response, NextFunction } from 'express';
import { BadRequestError } from '../../utils/errors';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that specified route params are valid UUIDs
 * @param paramNames Names of route params to validate
 */
export function validateUuidParams(...paramNames: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    for (const paramName of paramNames) {
      const value = req.params[paramName];
      if (value && !UUID_REGEX.test(value)) {
        return next(new BadRequestError(`Invalid ${paramName} format`));
      }
    }
    next();
  };
}
