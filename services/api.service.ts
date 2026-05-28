'use strict';

import moleculer, { Context } from 'moleculer';
import { Service } from 'moleculer-decorators';
import ApiGateway from 'moleculer-web';
import { parseCookies, SESSION_COOKIE_NAME } from '../utils/cookies';
import { verifySession, AuthUser } from '../utils/auth';
import { EndpointType, UserRole } from '../types/constants';

const { UnAuthorizedError, ERR_NO_TOKEN, ERR_INVALID_TOKEN } = ApiGateway.Errors;

/**
 * CORS origin whitelist resolved from `CORS_ORIGINS` env (comma-separated).
 * Dev fallback: localhost:5173 (Vite default). Never use `origin: '*'` here
 * — the API issues credentialed cookies and a wildcard origin with
 * `credentials: true` is both spec-violating and a misconfig signal.
 */
const DEV_ORIGINS = ['http://localhost:5173'];

function resolveCorsOrigins(): string[] {
  const raw = (process.env.CORS_ORIGINS || '').trim();
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return process.env.NODE_ENV === 'production' ? [] : DEV_ORIGINS;
}

/**
 * Connect-style middleware setting a baseline of security response headers.
 */
function securityHeadersMiddleware(_req: any, res: any, next: any) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  );
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader?.('X-Powered-By');
  next();
}

/**
 * Meta attached to every request by `authenticate()`. Downstream services
 * read `ctx.meta.user` for authorization decisions and `ctx.meta.cookies`
 * when verifying short-lived auth-flow cookies (OAuth state).
 */
export interface UserAuthMeta {
  user?: AuthUser;
  cookies?: Record<string, string>;
  clientIp?: string;
  /** Internal-call bypass for trusted self-lookups. Never sourced from input. */
  _systemTransition?: boolean;
}

@Service({
  name: 'api',
  mixins: [ApiGateway],
  settings: {
    port: process.env.PORT || 3000,
    path: '/api',

    use: [securityHeadersMiddleware],

    cors: {
      origin: resolveCorsOrigins(),
      methods: ['GET', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Requested-With'],
      exposedHeaders: ['Content-Disposition'],
      credentials: true,
      maxAge: null,
    },

    routes: [
      {
        path: '/',
        whitelist: ['**'],
        use: [],
        mergeParams: true,
        authentication: true,
        authorization: true,
        autoAliases: true,
        // Explicit alias so the FE can hit `/api/health` without the
        // `/api/api/...` double-prefix that autoAliases produces for actions
        // on the `api` service (it prepends the service name).
        aliases: {
          'GET /health': 'api.health',
          // Explicit alias so the admin login path is `/api/auth/admin-login`
          // rather than `/api/adminAuth/auth/admin-login` that autoAliases
          // would publish (service-name prefix).
          'POST /auth/admin-login': 'adminAuth.adminLogin',
        },
        bodyParsers: {
          // JSON payload limit. Reservation payloads are tiny (a few hundred
          // bytes); the cap is here to keep an unauthenticated POST from
          // tying up the event loop parsing junk.
          json: { strict: false, limit: '2MB' },
          urlencoded: { extended: true, limit: '2MB' },
        },
        mappingPolicy: 'restrict',
        logging: true,
      },
    ],

    log4XXResponses: false,
    logRequestParams: null,
    logResponseData: null,

    onError(req: any, res: any, err: any) {
      // Production response hardening: don't echo internal 5xx messages back
      // to the client. Validation/auth 4xx keep their original Lithuanian
      // messages so the FE can render them verbatim.
      const isProd = process.env.NODE_ENV === 'production';
      const status = err.code || 500;
      const isServerError = status >= 500;
      const safeMessage =
        isProd && isServerError
          ? 'Vidinė serverio klaida.'
          : err.message || 'Internal server error';

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(status);
      res.end(
        JSON.stringify({
          name: err.name || 'Error',
          message: safeMessage,
          type: err.type,
          code: status,
          data: isProd && isServerError ? undefined : err.data,
        }),
      );
    },
  },

  actions: {
    /**
     * Liveness/readiness probe. Hit by Docker HEALTHCHECK + biip-infra deploy
     * verification. Unauthenticated. Returns 200 even if downstream
     * dependencies (DB) are sick — kubelet-style "process alive" semantic;
     * deeper readiness checks will land in a `/api/ready` action later.
     */
    health: {
      // No `rest:` here — autoAliases would publish this as `GET /api/api/health`
      // (service name prefix). The route-level `aliases` map publishes
      // `GET /api/health` instead.
      auth: false,
      handler() {
        return { status: 'ok', ts: Date.now() };
      },
    },
  },

  methods: {
    async authenticate(
      ctx: Context<{}, UserAuthMeta>,
      _route: any,
      req: any,
    ): Promise<AuthUser | null> {
      // Capture client IP (trusts X-Forwarded-For unless TRUST_PROXY=0).
      const trustProxy = process.env.TRUST_PROXY !== '0';
      const xff = trustProxy ? (req.headers['x-forwarded-for'] as string | undefined) : undefined;
      ctx.meta.clientIp =
        (xff ? xff.split(',')[0].trim() : undefined) ||
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        'unknown';

      // Auth source: HttpOnly cookie (preferred — XSS-immune) > Authorization
      // header (legacy / API clients / curl).
      const cookieHeader: string | undefined = req.headers.cookie;
      const parsedCookies = cookieHeader ? parseCookies(cookieHeader) : {};
      ctx.meta.cookies = parsedCookies;
      const sessionFromCookie = parsedCookies[SESSION_COOKIE_NAME];

      const authHeader = req.headers.authorization;
      const tokenFromHeader = authHeader
        ? authHeader.replace(/^(Bearer|Token)\s+/i, '')
        : '';

      const token = sessionFromCookie || tokenFromHeader;
      if (!token) return null;

      const result = verifySession(token);
      if (!result.ok) return null;

      // Hydrate the user row from the DB so role changes take effect on the
      // next request rather than waiting for the JWT to expire. A deleted
      // user is treated as unauthenticated (`null` → gateway 401), which is
      // the safe fail-closed posture if an admin purges a compromised
      // account mid-session.
      let row: any;
      let lookupFailed = false;
      try {
        row = await ctx.broker.call(
          'users.resolveById',
          { id: String(result.payload.sub) },
          { meta: { _systemTransition: true } } as any,
        );
      } catch (err: any) {
        // DB blip — fall back to the JWT payload so the API stays usable
        // briefly. Persistent failures will show up in logs.
        lookupFailed = true;
        ctx.broker.logger.warn(
          `[api.authenticate] users.resolveById failed: ${err?.message || err}`,
        );
      }

      // Clean null (user deleted) — fail closed. Lookup exception — fall
      // back to JWT payload for transient resilience.
      if (!lookupFailed && row == null) return null;

      const user: AuthUser = {
        id: row?.id ? String(row.id) : String(result.payload.sub),
        role: (row?.role as UserRole) || (result.payload.role as UserRole) || UserRole.USER,
        email: row?.email,
        displayName: row?.displayName,
      };
      ctx.meta.user = user;
      return user;
    },

    async authorize(ctx: Context<{}, UserAuthMeta>, _route: any, req: any) {
      const action = req.$action;
      if (action?.auth === false) return null;

      if (!ctx.meta?.user?.id) {
        throw new UnAuthorizedError(ERR_NO_TOKEN, null);
      }

      // Per-action role gate.
      const allowedTypes: EndpointType[] | undefined = action?.types;
      if (allowedTypes?.length) {
        const role = ctx.meta.user.role;
        const ok =
          allowedTypes.includes(EndpointType.PUBLIC) ||
          (allowedTypes.includes(EndpointType.USER) && (role === UserRole.USER || role === UserRole.ADMIN)) ||
          (allowedTypes.includes(EndpointType.ADMIN) && role === UserRole.ADMIN);
        if (!ok) throw new UnAuthorizedError(ERR_INVALID_TOKEN, null);
      }

      return null;
    },
  },
})
export default class ApiService extends moleculer.Service {}
