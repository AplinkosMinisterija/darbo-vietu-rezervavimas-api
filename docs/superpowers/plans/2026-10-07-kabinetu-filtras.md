# Kabinetų filtras Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every screen that lists rooms the same three-control filter — text search (number + name), floor, and shared/private — so a user can find one of the 40 rooms without scrolling.

**Architecture:** One pure, tested filter helper in the web repo (`src/lib/roomFilter.ts`) drives the two client-side screens (Admin → Patalpos, citizen HomePage), because both already hold the full room list in the `RoomsProvider` context. The admin Rezervacijos list is server-paginated, so its floor/shared filtering goes through the API instead: `GET /reservations/all` gains `floor` and `shared` params, and the existing "Patalpa" dropdown is narrowed by the same two controls client-side.

**Tech Stack:** React 18 + TypeScript + styled-components + Vite + Vitest (web); Moleculer.js + Knex + Vitest (api).

**Spec:** https://github.com/AplinkosMinisterija/alis/issues/653 ("įdėti filtrą kabinetams"), scope agreed with the issue author 2026-10-07: all three screens, filter = search + floor + "Bendra?".

## Global Constraints

- Package manager is **Yarn** in both repos. Never `npm install`.
- **No new dependencies.** The filter is plain TS + existing styled primitives.
- TypeScript: no `any`, no `!` non-null assertions, no `@ts-ignore`. Write to `strict: true`.
- UI copy is **Lithuanian**; code, identifiers and comments are **English**… except that this codebase's existing comments are Lithuanian — match the file you are editing.
- WCAG 2.1 AA is a legal requirement (EU Directive 2016/2102): every filter control gets an accessible name via `<label htmlFor>` ↔ `id` (`useId()`).
- Shared constants live in the module that owns them (`src/lib/roomFilter.ts`); this repo has no `src/utils/constants.ts` and must not grow a second one.
- Admin filter controls reuse `FilterBar / FilterGroup / FilterLabel / FilterInput / FilterSelect` from `src/pages/admin/shared.ts` — do not hand-roll new styled inputs.
- Branch in both repos: `feat/kabinetu-filtras`. PRs are **draft, no assignees**, until the author says otherwise.

## Review Focus

1. **Diacritics and case.** A user types `teises` or `GRUPE`; rooms named `Teisės skyrius` and `Atliekų politikos grupė` must still match. Covered by Task 1 tests.
2. **`shared === false` must survive query-param building.** `shared || undefined` silently drops "Tik nebendros". Covered by Task 5 tests (web) and Task 4 tests (api).
3. **"Visi aukštai" must not be clobbered.** HomePage auto-selects the user's own floor on first load; picking "Visi" afterwards must stick. Covered by Task 3.
4. **A stale `roomId` outside the new floor.** Choosing Aukštas=3 while Patalpa=211 (2nd floor) must clear the room, not return an empty list with an invisible contradiction. Covered by Task 5.
5. **Pagination offset must reset on every filter change.** Otherwise offset=200 against a 12-row filtered result renders an empty page with "5 / 1". Covered by Task 5.

---

### Task 1: Pure room-filter helper

**Files:**
- Create: `darbo-vietu-rezervavimas-web/src/lib/roomFilter.ts`
- Test: `darbo-vietu-rezervavimas-web/src/lib/roomFilter.test.ts`

**Interfaces:**
- Consumes: `Room` from `src/types.ts`.
- Produces:
  - `type RoomSharedFilter = 'all' | 'shared' | 'private'`
  - `interface RoomFilter { query: string; floor: number | null; shared: RoomSharedFilter }`
  - `const EMPTY_ROOM_FILTER: RoomFilter`
  - `type FilterableRoom = Pick<Room, 'number' | 'name' | 'floor' | 'isShared'>`
  - `function normalizeSearchText(value: string): string`
  - `function filterRooms<T extends FilterableRoom>(rooms: T[], filter: RoomFilter): T[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  EMPTY_ROOM_FILTER,
  filterRooms,
  normalizeSearchText,
  type FilterableRoom,
} from './roomFilter';

const rooms: FilterableRoom[] = [
  { number: '211', name: 'Teisės skyrius', floor: 2, isShared: false },
  { number: '305', name: 'Europos Sąjungos ir tarptautinių ryšių grupė', floor: 3, isShared: false },
  { number: '307', name: 'Atliekų politikos grupė', floor: 3, isShared: false },
  { number: '309', name: 'Rezervuojamos darbo vietos', floor: 3, isShared: true },
];

describe('normalizeSearchText', () => {
  it('lowercases, trims and strips Lithuanian diacritics', () => {
    expect(normalizeSearchText('  Teisės ')).toBe('teises');
    expect(normalizeSearchText('ĄČĘĖĮŠŲŪŽ')).toBe('aceeisuuz');
  });
});

describe('filterRooms', () => {
  it('returns every room for the empty filter', () => {
    expect(filterRooms(rooms, EMPTY_ROOM_FILTER)).toHaveLength(4);
  });

  it('matches the room number as a substring', () => {
    expect(filterRooms(rooms, { ...EMPTY_ROOM_FILTER, query: '30' }).map((r) => r.number)).toEqual([
      '305',
      '307',
      '309',
    ]);
  });

  it('matches the name ignoring case and diacritics', () => {
    expect(filterRooms(rooms, { ...EMPTY_ROOM_FILTER, query: 'teises' }).map((r) => r.number)).toEqual(['211']);
    expect(filterRooms(rooms, { ...EMPTY_ROOM_FILTER, query: 'GRUPE' }).map((r) => r.number)).toEqual(['305', '307']);
  });

  it('filters by floor, where null means every floor', () => {
    expect(filterRooms(rooms, { ...EMPTY_ROOM_FILTER, floor: 3 })).toHaveLength(3);
    expect(filterRooms(rooms, { ...EMPTY_ROOM_FILTER, floor: null })).toHaveLength(4);
  });

  it('filters shared and private rooms', () => {
    expect(filterRooms(rooms, { ...EMPTY_ROOM_FILTER, shared: 'shared' }).map((r) => r.number)).toEqual(['309']);
    expect(filterRooms(rooms, { ...EMPTY_ROOM_FILTER, shared: 'private' })).toHaveLength(3);
  });

  it('combines all three criteria', () => {
    expect(
      filterRooms(rooms, { query: 'grupe', floor: 3, shared: 'private' }).map((r) => r.number),
    ).toEqual(['305', '307']);
  });

  it('keeps the input order and does not mutate the input array', () => {
    const input = [...rooms];
    filterRooms(input, { ...EMPTY_ROOM_FILTER, query: '3' });
    expect(input).toEqual(rooms);
  });
});

```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd darbo-vietu-rezervavimas-web && yarn vitest run src/lib/roomFilter.test.ts`
Expected: FAIL — `Failed to resolve import "./roomFilter"`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Room } from '../types';

/** „Bendra?" filtro reikšmės — `private` = NE bendra patalpa. */
export type RoomSharedFilter = 'all' | 'shared' | 'private';

export interface RoomFilter {
  query: string;
  /** `null` = visi aukštai. */
  floor: number | null;
  shared: RoomSharedFilter;
}

export const EMPTY_ROOM_FILTER: RoomFilter = { query: '', floor: null, shared: 'all' };

/** Minimali forma, kurios reikia filtrui — tinka ir `Room`, ir admin eilutėms. */
export type FilterableRoom = Pick<Room, 'number' | 'name' | 'floor' | 'isShared'>;

/**
 * Naudotojai dažnai renka be lietuviškų raidžių („teises" vietoj „Teisės"),
 * todėl prieš lyginant nuimame diakritikus (NFD + combining marks range).
 */
export function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function matchesQuery(room: FilterableRoom, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true;
  return (
    normalizeSearchText(room.number).includes(normalizedQuery) ||
    normalizeSearchText(room.name).includes(normalizedQuery)
  );
}

function matchesShared(room: FilterableRoom, shared: RoomSharedFilter): boolean {
  if (shared === 'all') return true;
  return shared === 'shared' ? room.isShared : !room.isShared;
}

export function filterRooms<T extends FilterableRoom>(rooms: T[], filter: RoomFilter): T[] {
  const normalizedQuery = normalizeSearchText(filter.query);
  return rooms.filter(
    (room) =>
      matchesQuery(room, normalizedQuery) &&
      (filter.floor === null || room.floor === filter.floor) &&
      matchesShared(room, filter.shared),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd darbo-vietu-rezervavimas-web && yarn vitest run src/lib/roomFilter.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roomFilter.ts src/lib/roomFilter.test.ts
git commit -m "feat(rooms): pure room filter helper (search + floor + shared)"
```

---

### Task 2: Admin → Patalpos filter bar

**Files:**
- Modify: `darbo-vietu-rezervavimas-web/src/pages/admin/AdminRoomsPage.tsx`

**Interfaces:**
- Consumes: `filterRooms`, `EMPTY_ROOM_FILTER`, `RoomFilter`, `RoomSharedFilter` from `src/lib/roomFilter`; `FilterBar`, `FilterGroup`, `FilterLabel`, `FilterInput`, `FilterSelect` from `./shared`.
- Produces: nothing other modules consume.

- [ ] **Step 1: Add the filter state and derive the grouped list from it**

Replace the `grouped` memo so it groups the FILTERED rooms, and keep the floor
options derived from the FULL list (so the floor select never collapses to the
floor you just picked):

```tsx
const [filter, setFilter] = useState<RoomFilter>(EMPTY_ROOM_FILTER);
const searchId = useId();
const floorId = useId();
const sharedId = useId();

const floors = useMemo(
  () => Array.from(new Set(rooms.map((r) => r.floor))).sort((a, b) => a - b),
  [rooms],
);

const visibleRooms = useMemo(() => filterRooms(rooms, filter), [rooms, filter]);

const grouped = useMemo(() => {
  const map = new Map<number, Room[]>();
  for (const r of visibleRooms) {
    const list = map.get(r.floor) ?? [];
    list.push(r);
    map.set(r.floor, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.number.localeCompare(b.number, 'lt', { numeric: true }));
  }
  return Array.from(map.entries()).sort(([a], [b]) => a - b);
}, [visibleRooms]);
```

Imports to add: `useId` from `react`, and the `roomFilter` + `shared` symbols above.

- [ ] **Step 2: Render the filter bar under the page header**

```tsx
<FilterBar>
  <FilterGroup>
    <FilterLabel htmlFor={searchId}>Paieška</FilterLabel>
    <FilterInput
      id={searchId}
      type="search"
      placeholder="numeris ar pavadinimas"
      value={filter.query}
      onChange={(e) => setFilter({ ...filter, query: e.target.value })}
    />
  </FilterGroup>
  <FilterGroup>
    <FilterLabel htmlFor={floorId}>Aukštas</FilterLabel>
    <FilterSelect
      id={floorId}
      value={filter.floor === null ? '' : String(filter.floor)}
      onChange={(e) => setFilter({ ...filter, floor: e.target.value === '' ? null : Number(e.target.value) })}
    >
      <option value="">Visi</option>
      {floors.map((f) => (
        <option key={f} value={f}>
          {f} a.
        </option>
      ))}
    </FilterSelect>
  </FilterGroup>
  <FilterGroup>
    <FilterLabel htmlFor={sharedId}>Bendra?</FilterLabel>
    <FilterSelect
      id={sharedId}
      value={filter.shared}
      onChange={(e) => setFilter({ ...filter, shared: e.target.value as RoomSharedFilter })}
    >
      <option value="all">Visos</option>
      <option value="shared">Tik bendros</option>
      <option value="private">Tik nebendros</option>
    </FilterSelect>
  </FilterGroup>
</FilterBar>
```

Import `RoomSharedFilter` as a type alongside `RoomFilter`.

- [ ] **Step 3: Add the "nothing matches the filter" empty state**

The existing branch only covers "no rooms at all". Extend it so a filtered-out
list does not render as a blank page:

```tsx
{isLoading && rooms.length === 0 ? (
  <Muted>Kraunama…</Muted>
) : rooms.length === 0 ? (
  <EmptyState>Patalpų sąraše dar nieko nėra. Pradėk pridėjant pirmąją.</EmptyState>
) : visibleRooms.length === 0 ? (
  <EmptyState>Pagal filtrą patalpų nerasta.</EmptyState>
) : (
  grouped.map(([floor, list]) => (
    /* unchanged */
  ))
)}
```

- [ ] **Step 4: Verify typecheck and lint pass**

Run: `cd darbo-vietu-rezervavimas-web && yarn typecheck && yarn lint`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/pages/admin/AdminRoomsPage.tsx
git commit -m "feat(admin): filter rooms list by search, floor and shared flag"
```

---

### Task 3: Citizen HomePage filter

**Files:**
- Modify: `darbo-vietu-rezervavimas-web/src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: `filterRooms`, `RoomSharedFilter` from `src/lib/roomFilter`.
- Produces: nothing other modules consume.

- [ ] **Step 1: Make the floor state nullable and resolve the default exactly once**

The current effect re-runs whenever `floor` is not in `floors`, which would
fight the new "Visi" option (`floor === null`). Replace it with a one-shot
initialisation:

```tsx
const [floor, setFloor] = useState<number | null>(null); // null = visi aukštai
const [query, setQuery] = useState('');
const [shared, setShared] = useState<RoomSharedFilter>('all');
const floorInitialized = useRef(false);

// Pirmą kartą gavę patalpas, atidarome naudotojo kabineto aukštą.
useEffect(() => {
  if (floorInitialized.current || rooms.length === 0) return;
  floorInitialized.current = true;
  const myRoom = rooms.find((r) => allowedIds.has(r.id) && !r.isShared);
  setFloor(myRoom ? myRoom.floor : (floors[0] ?? null));
}, [rooms, floors, allowedIds]);
```

Imports to add: `useRef` from `react`.

- [ ] **Step 2: Route the grid through the shared filter**

```tsx
const floorRooms = useMemo(
  () => filterRooms(rooms, { query, floor, shared }),
  [rooms, query, floor, shared],
);
```

(replaces `const floorRooms = rooms.filter((r) => r.floor === floor);`)

- [ ] **Step 3: Add the "Visi" tab plus the search and „Bendra?" controls**

```tsx
<FloorBar>
  <FloorLabel>Aukštas:</FloorLabel>
  {floors.length === 0 && !roomsLoading && <Muted>Patalpų sąrašas tuščias.</Muted>}
  <FloorTab type="button" $active={floor === null} onClick={() => setFloor(null)}>
    Visi
  </FloorTab>
  {floors.map((f) => (
    <FloorTab key={f} type="button" $active={f === floor} onClick={() => setFloor(f)}>
      {f}
    </FloorTab>
  ))}

  <SearchLabel htmlFor={searchId}>Ieškoti</SearchLabel>
  <SearchInput
    id={searchId}
    type="search"
    placeholder="kabineto numeris ar pavadinimas"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
  />

  <SearchLabel htmlFor={sharedId}>Bendra?</SearchLabel>
  <SharedSelect
    id={sharedId}
    value={shared}
    onChange={(e) => setShared(e.target.value as RoomSharedFilter)}
  >
    <option value="all">Visos</option>
    <option value="shared">Tik bendros</option>
    <option value="private">Tik nebendros</option>
  </SharedSelect>
</FloorBar>
```

with `const searchId = useId();` / `const sharedId = useId();` and three new
styled components next to the existing ones in the same file:

```tsx
const SearchLabel = styled.label`
  font-size: 14px;
  color: ${({ theme }) => theme.colors.textMute};
  margin-left: ${({ theme }) => theme.ui.spacing.sm};
`;

const SearchInput = styled.input`
  flex: 1 1 200px;
  min-width: 160px;
  padding: 6px 10px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.ui.radiusSm};
  font-size: 14px;
  background: ${({ theme }) => theme.colors.surface};
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.navy};
    outline-offset: 1px;
  }
`;

const SharedSelect = styled.select`
  padding: 6px 10px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.ui.radiusSm};
  font-size: 14px;
  background: ${({ theme }) => theme.colors.surface};
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.navy};
    outline-offset: 1px;
  }
`;
```

- [ ] **Step 4: Update the empty state wording**

`Šiame aukšte patalpų nėra.` is wrong once a search is active. Replace with:

```tsx
) : floorRooms.length === 0 ? (
  <Muted>Pagal filtrą patalpų nerasta.</Muted>
) : (
```

- [ ] **Step 5: Verify typecheck and lint pass**

Run: `cd darbo-vietu-rezervavimas-web && yarn typecheck && yarn lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/pages/HomePage.tsx
git commit -m "feat(home): search rooms and filter by shared flag, add all-floors tab"
```

---

### Task 4: API — floor and shared filters on GET /reservations/all

**Files:**
- Create: `darbo-vietu-rezervavimas-api/utils/reservationFilters.ts`
- Test: `darbo-vietu-rezervavimas-api/utils/reservationFilters.test.ts`
- Modify: `darbo-vietu-rezervavimas-api/services/reservations.service.ts:226-251`

**Interfaces:**
- Consumes: `Knex` types from `knex`.
- Produces:
  - `interface ReservationFilterParams { dateFrom?: string; dateTo?: string; userId?: string; roomId?: string; floor?: number; shared?: boolean }`
  - `function applyReservationFilters(query: Knex.QueryBuilder, params: ReservationFilterParams): Knex.QueryBuilder`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import knex from 'knex';
import { applyReservationFilters } from './reservationFilters';

// Builder-only instance: knex compiles SQL without ever opening a connection.
const db = knex({ client: 'pg' });
const base = () => db('reservations as r').leftJoin('rooms as room', 'room.id', 'r.room_id');

describe('applyReservationFilters', () => {
  it('adds no predicate when nothing is filtered', () => {
    expect(applyReservationFilters(base(), {}).toQuery()).not.toContain('where');
  });

  it('filters by the room floor', () => {
    const sql = applyReservationFilters(base(), { floor: 3 }).toQuery();
    expect(sql).toContain('"room"."floor" = 3');
  });

  it('keeps floor 0 — a falsy but valid floor', () => {
    expect(applyReservationFilters(base(), { floor: 0 }).toQuery()).toContain('"room"."floor" = 0');
  });

  it('keeps shared = false — a falsy but meaningful filter', () => {
    expect(applyReservationFilters(base(), { shared: false }).toQuery()).toContain(
      '"room"."is_shared" = false',
    );
  });

  it('filters by shared = true', () => {
    expect(applyReservationFilters(base(), { shared: true }).toQuery()).toContain(
      '"room"."is_shared" = true',
    );
  });

  it('combines date, user, room, floor and shared', () => {
    const sql = applyReservationFilters(base(), {
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      userId: '11111111-1111-1111-1111-111111111111',
      roomId: '22222222-2222-2222-2222-222222222222',
      floor: 2,
      shared: false,
    }).toQuery();
    expect(sql).toContain('"r"."date" >=');
    expect(sql).toContain('"r"."date" <=');
    expect(sql).toContain('"r"."user_id" =');
    expect(sql).toContain('"r"."room_id" =');
    expect(sql).toContain('"room"."floor" = 2');
    expect(sql).toContain('"room"."is_shared" = false');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd darbo-vietu-rezervavimas-api && yarn vitest run utils/reservationFilters.test.ts`
Expected: FAIL — cannot resolve `./reservationFilters`.

- [ ] **Step 3: Write minimal implementation**

```ts
'use strict';

import type { Knex } from 'knex';

export interface ReservationFilterParams {
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
  roomId?: string;
  floor?: number;
  shared?: boolean;
}

/**
 * Admin rezervacijų sąrašo filtrai. Užklausa jau turi `leftJoin('rooms as room')` —
 * `floor`/`shared` remiasi tuo alias'u. `undefined` tikrinam eksplicitiškai:
 * `floor: 0` ir `shared: false` yra validūs filtrai, o ne „nefiltruojam".
 */
export function applyReservationFilters(
  query: Knex.QueryBuilder,
  params: ReservationFilterParams,
): Knex.QueryBuilder {
  if (params.dateFrom) query.andWhere('r.date', '>=', params.dateFrom);
  if (params.dateTo) query.andWhere('r.date', '<=', params.dateTo);
  if (params.userId) query.andWhere('r.user_id', params.userId);
  if (params.roomId) query.andWhere('r.room_id', params.roomId);
  if (params.floor !== undefined) query.andWhere('room.floor', params.floor);
  if (params.shared !== undefined) query.andWhere('room.is_shared', params.shared);
  return query;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd darbo-vietu-rezervavimas-api && yarn vitest run utils/reservationFilters.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Wire the helper into `listAll`**

In `services/reservations.service.ts`, add to the action's `params` schema:

```ts
floor: { type: 'number', integer: true, convert: true, optional: true, min: 0, max: 10 },
shared: { type: 'boolean', convert: true, optional: true },
```

(`min: 0, max: 10` mirrors the `rooms.floor` field validation.)

Extend the `Context<...>` generic with `floor?: number; shared?: boolean;`, then
replace the four inline `if (ctx.params.…) baseQuery.andWhere(…)` lines with:

```ts
applyReservationFilters(baseQuery, ctx.params);
```

and import `applyReservationFilters` from `../utils/reservationFilters`.

- [ ] **Step 6: Run the full API check**

Run: `cd darbo-vietu-rezervavimas-api && yarn build && yarn lint && yarn test`
Expected: all three exit 0.

- [ ] **Step 7: Commit**

```bash
git add utils/reservationFilters.ts utils/reservationFilters.test.ts services/reservations.service.ts
git commit -m "feat(reservations): filter the admin list by room floor and shared flag"
```

---

### Task 5: Admin → Rezervacijos floor + shared filters

**Files:**
- Modify: `darbo-vietu-rezervavimas-web/src/api/admin.ts` (`ReservationListParams`)
- Modify: `darbo-vietu-rezervavimas-web/src/pages/admin/AdminReservationsPage.tsx`

**Interfaces:**
- Consumes: `filterRooms`, `RoomSharedFilter` from `src/lib/roomFilter`; `floor` / `shared` params from Task 4.
- Produces: nothing other modules consume.

- [ ] **Step 1: Extend the API client params**

In `src/api/admin.ts`:

```ts
export interface ReservationListParams {
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
  roomId?: string;
  /** Patalpos aukštas — `undefined` reiškia „visi aukštai". */
  floor?: number;
  /** `true` — tik bendros patalpos, `false` — tik nebendros. */
  shared?: boolean;
  limit?: number;
  offset?: number;
}
```

- [ ] **Step 2: Add the two filter states and send them to the API**

```tsx
const [floor, setFloor] = useState<number | null>(null);
const [shared, setShared] = useState<RoomSharedFilter>('all');
```

In the `load` callback — note `shared` maps through an explicit ternary, because
`shared === false` must reach the API and `shared || undefined` would drop it:

```tsx
const data = await adminApi.reservations.listAll({
  dateFrom: dateFrom || undefined,
  dateTo: dateTo || undefined,
  userId: resolvedUserId,
  roomId: roomId || undefined,
  floor: floor ?? undefined,
  shared: shared === 'all' ? undefined : shared === 'shared',
  limit: PAGE_SIZE,
  offset,
});
```

Add `floor` and `shared` to the `load` dependency array **and** to the
offset-reset effect:

```tsx
useEffect(() => {
  setOffset(0);
}, [dateFrom, dateTo, roomId, resolvedUserId, floor, shared]);
```

- [ ] **Step 3: Narrow the Patalpa dropdown with the same two criteria, and drop a stale selection**

```tsx
const sortedRooms = useMemo(
  () =>
    [...filterRooms(rooms, { query: '', floor, shared })].sort(
      (a, b) => a.floor - b.floor || a.number.localeCompare(b.number, 'lt', { numeric: true }),
    ),
  [rooms, floor, shared],
);

// Pasirinkta patalpa iškritusi iš susiaurinto sąrašo — kitaip filtrai
// prieštarautų vienas kitam ir lentelė liktų tuščia be paaiškinimo.
useEffect(() => {
  if (roomId && !sortedRooms.some((r) => r.id === roomId)) setRoomId('');
}, [roomId, sortedRooms]);
```

- [ ] **Step 4: Render the two new controls in the existing FilterBar**

Insert before the existing "Patalpa" group, with `useId()`-backed labels:

```tsx
<FilterGroup>
  <FilterLabel htmlFor={floorId}>Aukštas</FilterLabel>
  <FilterSelect
    id={floorId}
    value={floor === null ? '' : String(floor)}
    onChange={(e) => setFloor(e.target.value === '' ? null : Number(e.target.value))}
  >
    <option value="">Visi</option>
    {allFloors.map((f) => (
      <option key={f} value={f}>
        {f} a.
      </option>
    ))}
  </FilterSelect>
</FilterGroup>
<FilterGroup>
  <FilterLabel htmlFor={sharedId}>Bendra?</FilterLabel>
  <FilterSelect
    id={sharedId}
    value={shared}
    onChange={(e) => setShared(e.target.value as RoomSharedFilter)}
  >
    <option value="all">Visos</option>
    <option value="shared">Tik bendros</option>
    <option value="private">Tik nebendros</option>
  </FilterSelect>
</FilterGroup>
```

with

```tsx
const allFloors = useMemo(
  () => Array.from(new Set(rooms.map((r) => r.floor))).sort((a, b) => a - b),
  [rooms],
);
```

- [ ] **Step 5: Give the pre-existing filter controls accessible names too**

The four controls already in this `FilterBar` (`Data nuo`, `Data iki`,
`Vartotojas`, `Patalpa`) use `FilterLabel` — a `styled.label` with no `htmlFor`,
so screen readers see unnamed fields. Wire each to its control with a `useId()`
id, same as the new ones. (WCAG 2.1 AA, and this change touches that bar.)

- [ ] **Step 6: Verify typecheck, lint and tests pass**

Run: `cd darbo-vietu-rezervavimas-web && yarn typecheck && yarn lint && yarn test`
Expected: all three exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/api/admin.ts src/pages/admin/AdminReservationsPage.tsx
git commit -m "feat(admin): filter reservations by room floor and shared flag"
```

---

### Task 6: Live verification and audit

**Files:**
- No source changes expected; fixes land in the task that owns the file.

- [ ] **Step 1: Run both repos locally and walk the acceptance checklist**

Admin → Patalpos: type `teises` → only 211; `Aukštas = 3` → only 3rd-floor
sections; `Bendra? = Tik bendros` → only 309; all three together → correct
intersection; clearing all three restores 40 rooms.

HomePage: default floor is still the user's own; `Visi` shows every floor and
stays selected; search finds `305` from another floor while `Visi` is active;
`Bendra?` narrows to shared rooms.

Rezervacijos: `Aukštas = 3` narrows both the table and the Patalpa dropdown;
picking a 2nd-floor room then switching to `Aukštas = 3` clears the room;
`Bendra? = Tik nebendros` returns non-shared rooms only (not an empty list);
changing any filter resets pagination to page 1.

- [ ] **Step 2: Confirm zero console errors and a 375×812 mobile layout**

Both filter bars wrap instead of overflowing; no horizontal scroll.

- [ ] **Step 3: Run the audit cycle**

```bash
# from the web repo
Workflow({ scriptPath: '/home/lukas/.claude/workflows/full-audit.js',
           args: { base: 'main', url: 'http://localhost:5173' } })
```

Fix every P0/P1 in the task that owns the file, then re-run.

- [ ] **Step 4: Open the two draft PRs**

Ask the author first whether they should be draft and whether to add reviewers
(`kaukaz`, `arunas-smala`, `LWangllix`) — never assign unprompted.

```bash
gh pr create --base main --draft \
  --title "Kabinetų filtras: paieška, aukštas ir „Bendra?“" \
  --body "<short body, closes AplinkosMinisterija/alis#653>"
```
