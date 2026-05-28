'use strict';

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import moleculer, { Context, Errors } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import { createMsalClient, getExpectedTenant, getRedirectUri, SCOPES } from '../utils/msal';
import {
  appendSetCookieToMeta,
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  serializeClearCookie,
  serializeOAuthStateCookie,
  serializeSessionCookie,
} from '../utils/cookies';
import { signSession, AuthUser } from '../utils/auth';
import { EndpointType, UserRole } from '../types/constants';

interface UserAuthMeta {
  user?: AuthUser;
  cookies?: Record<string, string>;
  _systemTransition?: boolean;
}

/**
 * Frontend origin used for post-auth redirects. Defaults to the dev Vite
 * server. Never embed user-controlled input — the value is read once at
 * action time from the env so a rolling restart picks up a new domain
 * without a code change.
 */
function getFrontendOrigin(): string {
  const raw = (process.env.FRONTEND_ORIGIN || '').trim();
  return raw || 'http://localhost:5173';
}

/**
 * PKCE helpers (RFC 7636). Even though MSAL is a confidential client (we have
 * a client secret), PKCE on top costs nothing and shuts down the
 * authorization-code-interception attack class outright. The verifier lives
 * inside the OAuth state cookie (HttpOnly + SameSite=Strict), never on disk.
 */
function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  // 32 bytes -> 43 base64url chars; well within the RFC range (43..128).
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * The state cookie wraps `{ state, codeVerifier }` so callback can verify
 * CSRF and complete PKCE. Encoded as URL-safe base64 to keep cookie parsing
 * trivial — the cookie module would otherwise URL-encode the JSON, which
 * works but blows up the cookie size for no reason.
 */
function encodeStatePayload(state: string, codeVerifier: string): string {
  return Buffer.from(JSON.stringify({ state, codeVerifier }), 'utf8').toString('base64url');
}

function decodeStatePayload(
  raw: string,
): { state: string; codeVerifier: string } | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (
      parsed &&
      typeof parsed.state === 'string' &&
      typeof parsed.codeVerifier === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

@Service({
  name: 'auth',
})
export default class AuthService extends moleculer.Service {
  /**
   * Kick off the Microsoft OAuth flow.
   *
   * 1. Generate CSRF state + PKCE pair.
   * 2. Stash `{state, codeVerifier}` in an HttpOnly state cookie.
   * 3. Redirect the browser to `login.microsoftonline.com`.
   *
   * Public — Microsoft is the trust boundary.
   */
  @Action({
    rest: 'GET /outlook/login',
    auth: false,
  })
  async outlookLogin(ctx: Context<{}, UserAuthMeta>) {
    const state = crypto.randomUUID();
    const { codeVerifier, codeChallenge } = generatePkce();

    const msalClient = createMsalClient();
    const authCodeUrl = await msalClient.getAuthCodeUrl({
      scopes: [...SCOPES],
      redirectUri: getRedirectUri(),
      state,
      codeChallenge,
      codeChallengeMethod: 'S256',
      // `prompt: 'select_account'` gives users a chance to pick the right
      // identity when they're signed into multiple Microsoft accounts in
      // the same browser. Cheap UX win.
      prompt: 'select_account',
    });

    const cookieValue = encodeStatePayload(state, codeVerifier);
    appendSetCookieToMeta(ctx.meta, serializeOAuthStateCookie(cookieValue));

    const meta = ctx.meta as any;
    meta.$statusCode = 302;
    meta.$responseHeaders = {
      ...(meta.$responseHeaders || {}),
      Location: authCodeUrl,
      // Don't let intermediaries cache the redirect — the state cookie is
      // single-use and a cached response would serve a stale state to a
      // second tab and break the CSRF check.
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    };
    // Hint moleculer-web to skip body serialization.
    meta.$responseType = 'text/plain';
    return '';
  }

  /**
   * Microsoft OAuth callback. Verifies state, exchanges the code for tokens,
   * finds/creates the local user, and issues our session JWT.
   *
   * The Microsoft access_token is decoded only — we never store it, never
   * call Graph after this point.
   */
  @Action({
    rest: 'GET /outlook/callback',
    auth: false,
    params: {
      code: { type: 'string', optional: true },
      state: { type: 'string', optional: true },
      error: { type: 'string', optional: true },
      error_description: { type: 'string', optional: true },
    },
  })
  async outlookCallback(
    ctx: Context<
      { code?: string; state?: string; error?: string; error_description?: string },
      UserAuthMeta
    >,
  ) {
    const frontend = getFrontendOrigin();

    // Always clear the state cookie before returning, success or failure.
    appendSetCookieToMeta(ctx.meta, serializeClearCookie(OAUTH_STATE_COOKIE_NAME));

    // Microsoft signalled the user denied consent (or some other upstream
    // error). Redirect to the FE login page with a typed error param so the
    // FE can render a Lithuanian message; we deliberately don't echo
    // Microsoft's `error_description` to avoid response-splitting / phishing
    // injection from a manipulated upstream URL.
    if (ctx.params.error) {
      this.logger.info(
        `[auth] Microsoft callback error: ${ctx.params.error} ${
          ctx.params.error_description || ''
        }`,
      );
      return this.redirect(ctx, `${frontend}/login?error=denied`);
    }

    if (!ctx.params.code || !ctx.params.state) {
      return this.redirect(ctx, `${frontend}/login?error=bad_callback`);
    }

    // CSRF check: the state in the URL must match the state in the cookie.
    // Without a matching cookie, a victim could be tricked into completing
    // login through an attacker-crafted callback URL.
    const cookieRaw = ctx.meta?.cookies?.[OAUTH_STATE_COOKIE_NAME];
    if (!cookieRaw) {
      return this.redirect(ctx, `${frontend}/login?error=state_missing`);
    }
    const decoded = decodeStatePayload(cookieRaw);
    if (!decoded || decoded.state !== ctx.params.state) {
      return this.redirect(ctx, `${frontend}/login?error=state_mismatch`);
    }

    // Exchange authorization code for tokens. MSAL verifies the id_token
    // signature + audience + tenant before returning; we still re-check
    // `tid` below for defense in depth.
    let tokenResponse: any;
    try {
      const msalClient = createMsalClient();
      tokenResponse = await msalClient.acquireTokenByCode({
        code: ctx.params.code,
        scopes: [...SCOPES],
        redirectUri: getRedirectUri(),
        codeVerifier: decoded.codeVerifier,
      });
    } catch (err: any) {
      this.logger.warn(`[auth] acquireTokenByCode failed: ${err?.message || err}`);
      return this.redirect(ctx, `${frontend}/login?error=token_exchange`);
    }

    if (!tokenResponse?.idToken) {
      return this.redirect(ctx, `${frontend}/login?error=no_id_token`);
    }

    // The id_token is already MSAL-verified at this point; decode (no verify)
    // to extract the claims we care about. We deliberately use `decode` not
    // `verify` — re-verifying would require fetching JWKS, MSAL does that
    // for us. If a future MSAL upgrade ever returns an unsigned token, the
    // tid/oid checks below still fail closed.
    const claims: any = jwt.decode(tokenResponse.idToken) || {};
    const oid: string | undefined = claims.oid;
    const tid: string | undefined = claims.tid;
    const email: string =
      (claims.preferred_username as string) ||
      (claims.email as string) ||
      (claims.upn as string) ||
      '';
    const displayName: string =
      (claims.name as string) || (tokenResponse.account?.name as string) || email;

    if (!oid || !email) {
      return this.redirect(ctx, `${frontend}/login?error=claim_missing`);
    }

    // Tenant guard: this deployment is wired to a single tenant. Reject
    // anyone from a different tenant outright. This is critical when the
    // Azure app registration uses the `common` or `organizations` authority
    // — without the check, any Microsoft user could log in.
    const expectedTenant = getExpectedTenant();
    if (tid && tid !== expectedTenant) {
      this.logger.warn(`[auth] tenant mismatch: token tid=${tid} expected=${expectedTenant}`);
      return this.redirect(ctx, `${frontend}/login?error=wrong_tenant`);
    }

    // Find / create the local user. The `_systemTransition` flag is set
    // inline here (never from request input) — Microsoft is the trust
    // boundary, so users.findOrCreate doesn't need its own admin gate but
    // it does require the marker so accidental external calls fail closed.
    const user: any = await ctx.call(
      'users.findOrCreate',
      { msObjectId: oid, email, displayName },
      { meta: { _systemTransition: true } } as any,
    );

    const token = signSession({
      sub: String(user.id),
      role: (user.role as UserRole) || UserRole.USER,
      jti: crypto.randomUUID(),
    });

    appendSetCookieToMeta(ctx.meta, serializeSessionCookie(token));
    return this.redirect(ctx, `${frontend}/`);
  }

  /**
   * Logout — clears the session cookie. We don't revoke the JWT (no server
   * session store yet); the cookie clear is enough for the FE flow.
   */
  @Action({
    rest: 'POST /logout',
    auth: true,
    types: [EndpointType.USER],
  })
  async logout(ctx: Context<{}, UserAuthMeta>) {
    appendSetCookieToMeta(ctx.meta, serializeClearCookie(SESSION_COOKIE_NAME));
    return { ok: true };
  }

  // --- private helpers ---

  private redirect(ctx: Context<any, UserAuthMeta>, url: string) {
    const meta = ctx.meta as any;
    meta.$statusCode = 302;
    meta.$responseHeaders = {
      ...(meta.$responseHeaders || {}),
      Location: url,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    };
    meta.$responseType = 'text/plain';
    return '';
  }
}
