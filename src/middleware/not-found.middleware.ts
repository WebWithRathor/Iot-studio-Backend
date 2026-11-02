import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES } from '../constants/error-codes.constants';
import { AppError } from '../utils/error.util';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, ERROR_CODES.ROUTE_NOT_FOUND, `No route for ${req.method} ${req.baseUrl + req.path}.`));
}
