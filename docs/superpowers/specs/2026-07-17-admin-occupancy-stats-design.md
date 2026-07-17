# Admin occupancy statistics — design

Date: 2026-07-17
Repos: `stalu-rezervavimas-api`, `stalu-rezervavimas-web`
Status: approved (chart choices delegated to implementer; library/time-range/export
scope confirmed with the user)

## Goal

Admin-only dashboard showing desk-occupancy statistics over any period, with
day/week/month granularity, comparisons (reserved vs free capacity, share of
users who reserve), and an Excel export of the same period.

## Confirmed decisions

1. **Time selection** = free `from`–`to` date range with Day/Week/Month presets.
   Reservations carry only a `date` (whole-day) — no hour-level data exists, so
   no hourly breakdown. No DB changes.
2. **Chart library** = Recharts, loaded only in a lazily-split admin chunk
   (`React.lazy`) so regular users never download it.
3. **Excel export** = aggregate sheets + a detailed reservation list (admin-only
   endpoint, so per-person rows are acceptable).

## Data model facts (unchanged)

- `reservations(user_id, room_id, desk_number, date)` — one row = one desk, one
  whole day. Unique per `(room_id, desk_number, date)` and `(user_id, date)`.
- Capacity = Σ `desk_count` over non-deleted rooms.
- `knexSnakeCaseMappers()` is active — Knex results come back camelCase.

## Backend (`stats.service.ts` — extended, no new service)

### `GET /stats/admin?from=YYYY-MM-DD&to=YYYY-MM-DD`

Gate: `types: [EndpointType.ADMIN]` **and** `requireAdminHook` (defense in
depth, mirrors `export.service.ts`). Validation: both params match the date
pattern, `from <= to`, range capped at 5 years (guards accidental huge scans).

Response (single round-trip):

```ts
{
  capacity: number;                       // Σ desk_count, active rooms (today's config)
  days: { date: string; reserved: number }[];        // one entry per day in range
  byFloor: { floor: number; reserved: number; capacity: number }[];
  topRooms: { roomId: string; number: string; name: string;
              reserved: number; capacity: number }[]; // top 10 by reserved
  kpi: {
    totalReservations: number;
    workdayAvgOccupancyPct: number;       // Mon–Fri days only
    reservingUsers: number;               // distinct users with ≥1 reservation in range
    activeUsers: number;                  // non-deleted users total
    peakDay: { date: string; reserved: number } | null;
  };
}
```

Week/month bucketing happens client-side from `days[]` (≈365 rows/year — tiny
payload; granularity switch needs no refetch). Reservations joined to
non-deleted rooms only, matching the existing `byFloor` action.

### `GET /stats/admin/xlsx?from=&to=`

Same gate + validation. Pure `buildStatsWorkbook()` (ExcelJS) mirroring
`export.service.ts` (unit-testable, `$responseHeaders` + buffer). Sheets:

1. **Suvestinė** — period, capacity, KPI rows.
2. **Pagal dieną** — date, weekday, reserved, capacity, occupancy %.
3. **Pagal kabinetą** — number, name, floor, desk count, reservations, occupancy %.
4. **Pagal savaitės dieną** — Mon–Sun: avg reserved, avg occupancy %.
5. **Rezervacijos** — date, user name, email, room number/name, desk number.

Filename: `uzimtumo-ataskaita-<from>—<to>.xlsx`.

## Frontend (`/admin/statistika`, lazy-loaded)

- New `AdminStatsPage.tsx` under `src/pages/admin/`, route added inside the
  existing `RequireAdmin` + `AdminLayout` block via `React.lazy` + `Suspense`
  (Recharts stays out of the main bundle). Sidebar link "Statistika".
- **Period bar**: presets *Diena / Savaitė / Mėnuo / 30 d. / Visas laikotarpis*
  (whole period = first reservation → today, fetched range) + free from–to
  inputs; granularity toggle *Diena / Savaitė / Mėnuo* (client-side bucketing).
- **KPI tiles**: total reservations; workday avg occupancy %; reserving users
  ("34 iš 120"); peak day.
- **Charts** (Recharts):
  - Stacked bars over time: *Rezervuota* vs *Laisva* per bucket (the
    reserved-vs-not comparison).
  - Weekday profile: avg occupancy % Mon–Sun.
  - By floor: horizontal bars, occupancy %.
  - Top rooms: top 10 horizontal bars.
- **Export button** downloads the currently selected period via the xlsx
  endpoint (same blob-download helper pattern as `adminApi.export.downloadXlsx`).
- Bucketing util (`bucketDays(days, granularity)`) is a pure function with unit
  tests; weeks are ISO (Mon-start), buckets clipped to the selected range.

## Known limitation (documented in code)

Capacity uses the *current* room configuration — historical `desk_count`
changes aren't stored, so occupancy % for old periods is computed against
today's capacity.

## Security

- Both new endpoints: gateway `ADMIN` type + `requireAdminHook` before-hook.
- No new user input beyond two validated date params; no PII in the JSON
  aggregate response; PII (names/emails) only in the admin-gated xlsx.

## Testing

- API unit: aggregation SQL helpers mocked-free where pure; `buildStatsWorkbook`
  fed fixture rows (mirrors `export.service.test.ts`).
- FE unit: `bucketDays` (day/week/month edges, month boundaries, clipping).
- Live verify: admin login → charts render for presets + custom range → xlsx
  downloads and opens; non-admin gets 403 on both endpoints and no sidebar link.

## Acceptance checklist

1. `/stats/admin` and `/stats/admin/xlsx` return 403 for role USER, 200 for ADMIN.
2. `/admin/statistika` reachable only via admin layout; shows KPI tiles + 4 charts.
3. Presets Day/Week/Month/30d/whole-period and custom from–to work; granularity
   toggle rebuckets without a refetch.
4. Reserved-vs-free comparison visible in the time chart; users-reserving KPI shown.
5. Excel export downloads the 5-sheet workbook for the selected period.
6. Recharts absent from the main (non-admin) JS chunk.
7. Typecheck + lint + tests green in both repos.
