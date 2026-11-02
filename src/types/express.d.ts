import type { AuthUser } from './auth.types';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id, set by request-logger middleware and echoed as X-Request-Id. */
      requestId: string;
      /** Set by authenticate middleware. */
      user?: AuthUser;
      /** Parsed, validated input set by validate-request middleware. */
      validated: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };
    }
  }
}

export {};
