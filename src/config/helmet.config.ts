import { loadEnv } from './env.config';

/**
 * This server only serves JSON and an SSE stream — never HTML — so the CSP
 * can be maximally strict without affecting the frontend (which is served
 * by Vite / its own host and keeps its own CSP).
 */
export function helmetConfig() {
  const e = loadEnv();
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' as const },
    crossOriginOpenerPolicy: { policy: 'same-origin' as const },
    referrerPolicy: { policy: 'no-referrer' as const },
    hsts: e.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    frameguard: { action: 'deny' as const },
    noSniff: true,
    hidePoweredBy: true,
  };
}
