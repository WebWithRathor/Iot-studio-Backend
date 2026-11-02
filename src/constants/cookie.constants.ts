export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * The refresh cookie is scoped to the auth routes only, so it is never sent
 * with ordinary API requests. Relative to API_BASE_PATH.
 */
export const REFRESH_COOKIE_SUBPATH = '/auth';

/** Header every state-changing request must carry (CSRF defence, see csrf.middleware). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'XMLHttpRequest';
