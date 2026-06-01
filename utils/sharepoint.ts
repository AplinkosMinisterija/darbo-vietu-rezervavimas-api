'use strict';

/**
 * SharePoint / Microsoft Graph integration (app-only, client_credentials).
 *
 * IMPORTANT: this is a SEPARATE Azure app registration from the OAuth login
 * (see utils/msal.ts). The login app federates user identities; THIS app
 * holds Graph `Sites.Selected`/`Sites.Read.All` and reads the ministry
 * intranet's remote-work list. Keep the two sets of credentials apart —
 * never reuse OUTLOOK_* here.
 *
 * All config is OPTIONAL. If the SHAREPOINT_* env vars are unset,
 * `readSharePointConfig()` returns null and the caller
 * (sharepointSync.service) disables itself. This keeps staging/prod compose
 * runs green before the integration is wired there (dev-first rollout) and
 * lets prod self-skip the sync until its own credentials are added.
 *
 * Uses the global `fetch` (Node 18+); no extra HTTP dependency.
 */

interface SharePointConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  /** Graph site path, e.g. "host.sharepoint.com:/sites/intranet". */
  sitePath: string;
  /** Display name of the remote/hybrid-work list. */
  listName: string;
}

/**
 * Internal SharePoint column names on the "Nuotoliniu būdu arba mišriai
 * dirbančių darbuotojų sąrašas" list. These are stable SharePoint-generated
 * internal names (verified against the live list 2026-06-01). They encode
 * Lithuanian characters via `_xHHHH_` escapes — do not "clean them up".
 */
const MODE_FIELD = 'Nuotolinio_x0020_darbo_x0020_b_x';
const EMPLOYEE_LOOKUP_FIELD = 'DarbuotojovardasPavard_x0117_LookupId';

/** Remote-work mode value meaning "works full-day from the ministry only". */
const ONSITE_ONLY_VALUE = 'Vien tik iš AM';

const DEFAULT_SITE_PATH = 'lraplinkosministerija.sharepoint.com:/sites/intranet';
const DEFAULT_LIST_NAME = 'Nuotoliniu būdu arba mišriai dirbančių darbuotojų sąrašas';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export function readSharePointConfig(): SharePointConfig | null {
  const clientId = (process.env.SHAREPOINT_CLIENT_ID || '').trim();
  const clientSecret = (process.env.SHAREPOINT_CLIENT_SECRET || '').trim();
  const tenantId = (process.env.SHAREPOINT_TENANT_ID || '').trim();
  if (!clientId || !clientSecret || !tenantId) return null;
  return {
    clientId,
    clientSecret,
    tenantId,
    sitePath: (process.env.SHAREPOINT_SITE_PATH || DEFAULT_SITE_PATH).trim(),
    listName: (process.env.SHAREPOINT_LIST_NAME || DEFAULT_LIST_NAME).trim(),
  };
}

export function isSharePointConfigured(): boolean {
  return readSharePointConfig() !== null;
}

export interface OnSitePerson {
  /** Display name from the SharePoint User Information List (may be null). */
  name: string | null;
  /** Resolved email (may be @am.lt or @*.onmicrosoft.com, or null). */
  email: string | null;
}

async function acquireToken(cfg: SharePointConfig): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SharePoint token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json: any = await res.json();
  if (!json.access_token) {
    throw new Error('SharePoint token response missing access_token');
  }
  return json.access_token as string;
}

async function graphGet(token: string, url: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph GET failed (${res.status}) for ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Follows @odata.nextLink to collect every page of a Graph collection. */
async function graphGetAll(token: string, url: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = url;
  while (next) {
    const page: any = await graphGet(token, next);
    out.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }
  return out;
}

async function findListId(token: string, siteId: string, displayName: string): Promise<string> {
  const lists = await graphGetAll(
    token,
    `${GRAPH}/sites/${siteId}/lists?$select=name,displayName,id&$top=200`,
  );
  const match = lists.find((l) => l.displayName === displayName);
  if (!match) {
    throw new Error(`SharePoint list "${displayName}" not found on site ${siteId}`);
  }
  return match.id;
}

/**
 * The hidden User Information List maps each list item's person LookupId to a
 * display name + email. It isn't returned by name reliably, so we match by
 * template ("userInformation") with a "users" name fallback.
 */
async function findUserInfoListId(token: string, siteId: string): Promise<string | null> {
  // The User Information List is a HIDDEN system list. Graph's /lists omits
  // hidden system lists UNLESS the `system` facet is selected — without it the
  // list is absent from the response and person lookups can't be resolved.
  const lists = await graphGetAll(
    token,
    `${GRAPH}/sites/${siteId}/lists?$select=name,displayName,id,list,system&$top=200`,
  );
  const match = lists.find(
    (l) => (l.list && l.list.template === 'userInformation') || l.name === 'users',
  );
  return match ? match.id : null;
}

/**
 * Returns the employees whose remote-work mode is "Vien tik iš AM" — i.e.
 * they work full-day from the ministry with no remote arrangement.
 *
 * Deduplicated per employee (latest entry kept by `Created`), resolved to
 * name + email via the User Information List.
 */
export async function fetchOnSiteOnlyEmployees(): Promise<OnSitePerson[]> {
  const cfg = readSharePointConfig();
  if (!cfg) throw new Error('SharePoint is not configured (SHAREPOINT_* env vars unset).');

  const token = await acquireToken(cfg);

  // 1. Resolve the site.
  const site = await graphGet(token, `${GRAPH}/sites/${cfg.sitePath}`);
  const siteId: string = site.id;
  if (!siteId) throw new Error(`Could not resolve SharePoint site id for ${cfg.sitePath}`);

  // 2. Resolve the remote/hybrid-work list + the User Information List.
  const [listId, userInfoListId] = await Promise.all([
    findListId(token, siteId, cfg.listName),
    findUserInfoListId(token, siteId),
  ]);

  // 3. Build LookupId -> {name,email} map from the User Information List.
  const people = new Map<string, { name: string | null; email: string | null }>();
  if (userInfoListId) {
    const users = await graphGetAll(
      token,
      `${GRAPH}/sites/${siteId}/lists/${userInfoListId}/items?$expand=fields($select=Title,EMail)&$top=500`,
    );
    for (const it of users) {
      const f = it.fields || {};
      people.set(String(it.id), { name: f.Title ?? null, email: f.EMail ?? null });
    }
  }

  // 4. Pull all list items, keep on-site-only, dedupe per employee (latest).
  const items = await graphGetAll(
    token,
    `${GRAPH}/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=500`,
  );
  const latestByEmployee = new Map<string, any>();
  for (const it of items) {
    const f = it.fields || {};
    if (f[MODE_FIELD] !== ONSITE_ONLY_VALUE) continue;
    const empId = f[EMPLOYEE_LOOKUP_FIELD];
    if (empId === undefined || empId === null) continue;
    const key = String(empId);
    const prev = latestByEmployee.get(key);
    if (!prev || String(f.Created || '') > String((prev.fields || {}).Created || '')) {
      latestByEmployee.set(key, it);
    }
  }

  const result: OnSitePerson[] = [];
  for (const [empId, it] of latestByEmployee) {
    const p = people.get(empId);
    result.push({ name: p?.name ?? null, email: p?.email ?? null });
  }
  return result;
}
