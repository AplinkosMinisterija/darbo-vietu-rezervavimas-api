'use strict';

import https from 'https';

/**
 * Scrapes the public AM contacts page to derive room managers: department
 * heads (skyriaus vedėjas/vedėja, grupės vadovas/vadovė, departamento
 * direktorius) are matched to the room whose name equals their unit. Emails on
 * the page are Cloudflare-obfuscated (`data-cfemail` hex) — decoded here.
 *
 * Pure parsing + matching (no DB). The service feeds in the room list and maps
 * matched units → room ids, falling back to a small manual override map for the
 * handful of units whose page wording differs from the room name.
 */
export const AM_CONTACTS_URL =
  'https://am.lrv.lt/lt/struktura-ir-kontaktine-informacija/kontaktai-2/';

export interface AmLeader {
  name: string;
  dept: string;
  position: string;
  email: string;
}

/** Manual unit → room-number overrides for units whose page name differs from
 *  the DB room name (verified 2026-06; admin can still override per room). */
const UNIT_ROOM_OVERRIDES: Record<string, string[]> = {
  'informacinių technologijų valdymo skyrius': ['403'],
  'europos sąjungos investicijų valdymo skyrius': ['108'],
  'aplinkos apsaugos politikos įgyvendinimo koordinavimo grupė': ['407'],
};

export function decodeCfEmail(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&ndash;/g, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

export function httpsGetText(url: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'stalu-rezervavimas-bot/1.0 (+biip)' } },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('AM contacts fetch timeout')));
  });
}

/**
 * Parse leadership rows (department heads only) from the contacts HTML. The
 * page groups people into accordion sections; the section heading is the unit
 * name, which we attach as `dept`.
 */
export function parseLeadership(html: string): AmLeader[] {
  const out: AmLeader[] = [];
  // Each accordion section's content follows its heading anchor until the next.
  const parts = html.split(/<a [^>]*class="accordion-links[^>]*>/);
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    const dept = stripTags(seg.slice(0, seg.indexOf('</a>')));
    const rows = (seg.match(/<tr>[\s\S]*?<\/tr>/g) || []).filter((r) => /__cf_email__/.test(r));
    for (const row of rows) {
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      if (tds.length < 4) continue;
      const position = stripTags(tds[1]);
      if (!/vedėj|grupės vadov|direktor/i.test(position)) continue; // dept heads only
      const cf = (tds[3].match(/data-cfemail="([0-9a-f]+)"/) || [])[1];
      if (!cf) continue;
      out.push({
        name: stripTags(tds[0]),
        dept,
        position,
        email: decodeCfEmail(cf).toLowerCase().trim(),
      });
    }
  }
  return out;
}

function normUnit(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-ząčęėįšųūž0-9 ]/gi, ' ')
    .replace(/\b(skyrius|grupė|grupe|politikos|departamentas|valdymo|ir)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RoomLite {
  id: string;
  number: string;
  name: string;
}

/**
 * Map each leader's unit to room id(s). Tries exact name, then normalized,
 * then substring, then the manual override map. Returns one entry per leader
 * that resolved to at least one room (a unit name shared by several rooms maps
 * to all of them — e.g. 307+308 "Atliekų politikos grupė").
 */
export function matchLeadersToRooms(
  leaders: AmLeader[],
  rooms: RoomLite[],
): Array<{ email: string; roomIds: string[] }> {
  const byNumber = new Map(rooms.map((r) => [r.number, r]));
  const result: Array<{ email: string; roomIds: string[] }> = [];
  for (const lead of leaders) {
    const deptLc = lead.dept.toLowerCase();
    const deptNorm = normUnit(lead.dept);
    let matched = rooms.filter((r) => r.name.toLowerCase() === deptLc);
    if (!matched.length) matched = rooms.filter((r) => normUnit(r.name) === deptNorm && deptNorm);
    if (!matched.length)
      matched = rooms.filter(
        (r) => normUnit(r.name) && (normUnit(r.name).includes(deptNorm) || deptNorm.includes(normUnit(r.name))),
      );
    let roomIds = matched.map((r) => r.id);
    if (!roomIds.length) {
      const override = UNIT_ROOM_OVERRIDES[deptLc];
      if (override) roomIds = override.map((n) => byNumber.get(n)?.id).filter((x): x is string => !!x);
    }
    if (roomIds.length) result.push({ email: lead.email, roomIds: [...new Set(roomIds)] });
  }
  return result;
}
