'use strict';

import { ConfidentialClientApplication, Configuration } from '@azure/msal-node';

/**
 * Microsoft OAuth scopes requested at the consent screen.
 *
 * Intentionally minimal: we use Microsoft purely as a federated IdP. We
 * never call Graph beyond the implicit id_token decode at callback, so
 * no `Mail.Read`, no `offline_access` (we don't store refresh tokens).
 */
export const SCOPES = ['openid', 'profile', 'email', 'User.Read'] as const;

interface MsalEnv {
  clientId: string;
  clientSecret: string;
  tenant: string;
}

function readMsalEnv(): MsalEnv {
  const clientId = (process.env.OUTLOOK_CLIENT_ID || '').trim();
  const clientSecret = (process.env.OUTLOOK_CLIENT_SECRET || '').trim();
  const tenant = (process.env.OUTLOOK_TENANT || '').trim();

  const missing: string[] = [];
  if (!clientId) missing.push('OUTLOOK_CLIENT_ID');
  if (!clientSecret) missing.push('OUTLOOK_CLIENT_SECRET');
  if (!tenant) missing.push('OUTLOOK_TENANT');

  if (missing.length > 0) {
    throw new Error(
      `Microsoft OAuth env vars not configured: ${missing.join(', ')}. ` +
        'Set them in .env (dev) or via biip-infra INPUT_STALU_REZERVAVIMAS_* (deploy).',
    );
  }
  return { clientId, clientSecret, tenant };
}

/**
 * Returns the Microsoft tenant the deployment is wired to. Exposed for the
 * auth callback to assert `id_token.tid === expected tenant`.
 */
export function getExpectedTenant(): string {
  return readMsalEnv().tenant;
}

/**
 * Returns the OAuth redirect URI registered in Azure. The same URI must be
 * present on the Azure app registration's Redirect URIs list.
 */
export function getRedirectUri(): string {
  const uri = (process.env.OUTLOOK_REDIRECT_URI || '').trim();
  if (!uri) {
    throw new Error(
      'OUTLOOK_REDIRECT_URI env var must be set (e.g. https://stalu-rezervavimas.biip.lt/api/auth/outlook/callback).',
    );
  }
  return uri;
}

/**
 * Factory for an MSAL ConfidentialClientApplication. We create a fresh
 * client per call rather than cache a singleton — the env is read inside
 * `readMsalEnv()`, so reading at construction time gives any future env
 * rotation a clean path (a rolling restart picks up the new secret without
 * the process needing to track a stale handle).
 */
export function createMsalClient(): ConfidentialClientApplication {
  const env = readMsalEnv();
  const config: Configuration = {
    auth: {
      clientId: env.clientId,
      clientSecret: env.clientSecret,
      authority: `https://login.microsoftonline.com/${env.tenant}`,
    },
  };
  return new ConfidentialClientApplication(config);
}
