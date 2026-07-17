# Admin Occupancy Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-only occupancy dashboard (charts over any date range, day/week/month granularity, reserved-vs-free comparisons) + Excel export, per the approved spec `docs/superpowers/specs/2026-07-17-admin-occupancy-stats-design.md`.

**Architecture:** Two new admin-gated actions on the existing `stats` Moleculer service (JSON aggregate + xlsx). All week/month bucketing is client-side from a per-day series. New lazy-loaded React page `/admin/statistika` with Recharts.

**Tech Stack:** Moleculer + Knex (camelCase mappers) + ExcelJS + vitest (API); React 18 + styled-components + Recharts + vitest (web).

## Global Constraints

- Yarn only (never npm/pnpm); web Node >=20.
- `strict` TS, no `any` in new code.
- Both endpoints: `types: [EndpointType.ADMIN]` **and** `requireAdminHook` before-hook.
- Recharts must not enter the main (non-admin) bundle — `React.lazy` route.
- Lithuanian UI copy; English code/comments.
- Do NOT touch `services/reservations.service.ts` / its test (unrelated in-flight work).
- Commits on branch `feat/admin-stats` in both repos; stage files explicitly (working tree has unrelated dirty files).

---

### Task 1 (API): pure day-series + KPI helpers, TDD

**Files:**
- Modify: `services/stats.service.ts` (append exported pure functions)
- Test: `services/stats.service.test.ts` (new)

**Interfaces (Produces):**
```ts
export interface DayPoint { date: string; reserved: number } // date = 'YYYY-MM-DD'
export function buildDaySeries(from: string, to: string, reservedByDate: Map<string, number>): DayPoint[];
export interface StatsKpi {
  totalReservations: number;
  workdayAvgOccupancyPct: number; // 0–100, 1 decimal; 0 when capacity=0 or no workdays
  peakDay: { date: string; reserved: number } | null; // null when no reservations
}
export function computeKpis(days: DayPoint[], capacity: number): StatsKpi;
```

- [ ] **Step 1: failing tests** — `buildDaySeries` fills every calendar day in [from,to] with 0 when missing (incl. month/year boundaries, DST-safe via `Date.UTC` iteration); `computeKpis` averages occupancy over Mon–Fri days only, rounds to 1 decimal, `peakDay` = first max day, null on all-zero; capacity 0 → pct 0.
- [ ] **Step 2: run** `yarn vitest run services/stats.service.test.ts` → FAIL (not exported).
- [ ] **Step 3: implement** both functions (UTC iteration; `getUTCDay()` 1–5 = workday).
- [ ] **Step 4: run** → PASS.
- [ ] **Step 5: commit** `feat(stats): day-series and KPI helpers for admin dashboard`.

### Task 2 (API): `GET /stats/admin` aggregate endpoint

**Files:**
- Modify: `services/stats.service.ts` (new action `adminOverview`, rest `GET /admin`)

**Interfaces (Produces — response consumed by web Task 5/6):**
```ts
interface AdminStatsResponse {
  capacity: number; // Σ desk_count active rooms (single-day)
  range: { minDate: string | null; maxDate: string | null }; // MIN/MAX over ALL reservations
  days: DayPoint[];
  byFloor: { floor: number; reserved: number; capacity: number }[];
  topRooms: { roomId: string; number: string; name: string; reserved: number; deskCount: number }[]; // top 10 by reserved desc
  kpi: StatsKpi & { reservingUsers: number; activeUsers: number };
}
```

- [ ] Params: `from`/`to` match `DATE_PATTERN`, custom check `from <= to` and span ≤ 1827 days → else `MoleculerClientError(400, 'INVALID_RANGE')`.
- [ ] Queries (all join non-deleted rooms where applicable):
  - capacity: `SUM(desk_count)` active rooms;
  - per-day reserved: `to_char(res.date,'YYYY-MM-DD') AS ds, COUNT(*)` grouped;
  - byFloor: reuse the two-separate-aggregations pattern from `byFloor` (avoid join fan-out);
  - topRooms: count per room, `ORDER BY reserved DESC, number ASC LIMIT 10`;
  - reservingUsers: `COUNT(DISTINCT res.user_id)` in range (active rooms);
  - activeUsers: users where `deleted_at IS NULL`;
  - range: `MIN(date)/MAX(date)` over all reservations (no range filter).
- [ ] Gate: `types: [EndpointType.ADMIN]` + `requireAdminHook(ctx)` first line.
- [ ] `yarn build` (tsc) green; live curl happens in Task 8.
- [ ] Commit `feat(stats): admin occupancy aggregate endpoint`.

### Task 3 (API): stats workbook + `GET /stats/admin/xlsx`, TDD

**Files:**
- Modify: `services/stats.service.ts` (export `buildStatsWorkbook`, action `adminXlsx`)
- Test: `services/stats.service.test.ts` (extend)

**Interfaces:**
```ts
export interface StatsReservationDetailRow {
  date: string; displayName: string; email: string;
  roomNumber: string; roomName: string; deskNumber: number;
}
export interface StatsWorkbookInput {
  from: string; to: string; capacity: number;
  days: DayPoint[];
  rooms: { number: string; name: string; floor: number; deskCount: number; reserved: number }[];
  kpi: StatsKpi & { reservingUsers: number; activeUsers: number };
  detail: StatsReservationDetailRow[];
}
export function buildStatsWorkbook(input: StatsWorkbookInput): ExcelJS.Workbook;
```

- [ ] Sheets (mirror `buildExportWorkbook` style: frozen header, bold row 1):
  1. `Suvestinė` — key/value rows (laikotarpis, talpa, rezervacijų sk., vid. užimtumas darbo d. %, rezervavusių naudotojų sk. „X iš Y“, pikinė diena);
  2. `Pagal dieną` — Data, Savaitės diena (lt), Rezervuota, Talpa, Užimtumas %;
  3. `Pagal kabinetą` — Nr., Pavadinimas, Aukštas, Vietų, Rezervacijų, Užimtumas % (= reserved/(deskCount×days.length));
  4. `Pagal savaitės dieną` — Pr–Sk: dienų sk., vid. rezervuota, vid. užimtumas % (computed inside builder from `days`);
  5. `Rezervacijos` — Data, Vartotojas, El. paštas, Kabineto nr., Kabinetas, Stalo nr.
- [ ] Failing tests first: sheet names/headers; occupancy math incl. capacity=0 → 0 (no div-by-zero); weekday aggregation correctness; detail rows verbatim.
- [ ] Action `adminXlsx` (rest `GET /admin/xlsx`): same validation+gate as Task 2; detail query joins users+rooms ordered by date, displayName; sets `$responseHeaders` with `Content-Disposition: attachment; filename="uzimtumo-ataskaita-<from>--<to>.xlsx"`; returns buffer (mirror `export.service.ts`).
- [ ] `yarn vitest run` + `yarn build` green → commit `feat(stats): occupancy Excel export`.

### Task 4 (web): bucketing util, TDD

**Files:**
- Create: `src/lib/statsBuckets.ts`
- Test: `src/lib/statsBuckets.test.ts`

**Interfaces (Produces):**
```ts
export type Granularity = 'day' | 'week' | 'month';
export interface DayPoint { date: string; reserved: number }
export interface Bucket { key: string; label: string; reserved: number; dayCount: number }
export function bucketDays(days: DayPoint[], granularity: Granularity): Bucket[];
export function weekdayProfile(days: DayPoint[]): { weekday: number; label: string; avgReserved: number }[]; // 1..7 Pr..Sk
```

- [ ] Tests first: day = 1:1; week = ISO Mon-start, partial first/last bucket keeps real `dayCount`, key = Monday date, label `MM-DD–MM-DD`; month key `YYYY-MM`; weekdayProfile averages only over occurrences present in range; empty input → [].
- [ ] `yarn vitest run` FAIL → implement (UTC math, no deps) → PASS.
- [ ] Commit `feat(stats): day/week/month bucketing util`.

### Task 5 (web): recharts dep + API client + types

**Files:**
- Modify: `package.json` (`yarn add recharts`), `src/api/stats.ts`, `src/types.ts`

- [ ] `yarn add recharts` (then `yarn install --frozen-lockfile --ignore-engines` sanity per AM rule).
- [ ] `src/types.ts`: add `AdminStats` types matching Task 2 response.
- [ ] `src/api/stats.ts`: `adminStats(from, to)` GET `/stats/admin`; `downloadAdminXlsx(from, to)` — blob download copied from `adminApi.export.downloadXlsx` pattern (fallback filename `uzimtumo-ataskaita.xlsx`).
- [ ] `yarn typecheck` green → commit `feat(stats): admin stats API client + recharts dep`.

### Task 6 (web): AdminStatsPage + lazy route + sidebar link

**Files:**
- Create: `src/pages/admin/AdminStatsPage.tsx`
- Modify: `src/App.tsx` (React.lazy + Suspense route `statistika`), `src/components/layout/AdminLayout.tsx` (sidebar link „Statistika“)

- [ ] **Read the `dataviz` skill BEFORE chart code.**
- [ ] Page: period presets (Diena=today; Savaitė=last 7 d.; Mėnuo=current calendar month to date; 30 d.=last 30; Visas laikotarpis=`range.minDate→max(range.maxDate, today)`), from–to date inputs, granularity toggle.
- [ ] KPI tiles (4): rezervacijos; vid. užimtumas darbo d. %; rezervuoja X iš Y naudotojų; pikinė diena.
- [ ] Charts (Recharts, theme colors: reserved `#5FBD86`, free `#E5E7EB`, navy `#29346F` accents): stacked Rezervuota/Laisva bars over buckets (Laisva = capacity×dayCount−reserved, clamped ≥0); weekday profile bars (avg užimtumas %); byFloor horizontal bars (% of floor capacity × days); topRooms horizontal bars.
- [ ] Loading/error/empty states (existing page patterns); „Eksportuoti (Excel)“ button with busy state.
- [ ] `yarn typecheck && yarn lint && yarn test` green; `yarn build` → verify recharts chunk is separate (check `dist/assets` file list).
- [ ] Commit `feat(admin): occupancy statistics page with charts`.

### Task 7: quality gates both repos

- [ ] API: `yarn lint && yarn vitest run && yarn build`.
- [ ] Web: `yarn lint && yarn test && yarn typecheck && yarn build`.
- [ ] Fix anything red; commit fixes.

### Task 8: live verify (memory: local-run-verify-recipe)

- [ ] Start Postgres + API (6 env vars, standalone no NATS) + web dev server.
- [ ] curl: `/stats/admin` unauth → 401; USER token → 403; ADMIN → 200 sane JSON; invalid range (`from>to`, >5 y) → 400.
- [ ] Playwright MCP: admin login → `/admin/statistika` → charts render for presets + custom range, granularity switch без refetch (network tab), 0 console errors; export downloads file; xlsx opens (inspect via exceljs script) with 5 sheets; mobile 375×812 sanity.
- [ ] Non-admin user: no „Statistika“ link, direct URL redirected by RequireAdmin.

### Task 9: audit cycle

- [ ] Run full-audit workflow (`~/.claude/workflows/full-audit.js`, base main) or fallback review agents (security focus: new ADMIN endpoints, PII in xlsx; perf: range scan).
- [ ] Fix MUST-FIX findings; re-run gates; final report.

## Self-review

- Spec coverage: endpoints (T2/T3), page+charts (T6), presets+granularity (T4/T6), export (T3/T5/T6), security gates (T2/T3/T8), Recharts chunk isolation (T6), tests (T1/T3/T4), acceptance items → T8. `range` field added beyond spec to power „Visas laikotarpis“ preset (documented here).
- topRooms field named `deskCount` (clearer than spec's `capacity`) — FE computes %.
- No placeholders; types consistent across tasks.
