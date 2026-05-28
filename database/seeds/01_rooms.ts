'use strict';

import type { Knex } from 'knex';

/**
 * AM patalpų sąrašas iš prototipo. Atspindi 2026-05-28 fizinę būklę.
 *
 * `is_shared = true` — patalpa atvira VISIEMS user'iams nepriklausomai
 * nuo `user_room_assignments` (309 'Rezervuojamos darbo vietos' yra overflow
 * room visiems ministerijos darbuotojams).
 *
 * Idempotent — `onConflict('number').ignore()` perlaida nieko nedaro jei
 * patalpa jau seed'inta. Patalpos pakeitimai (desk_count, name) atliekami
 * per admin UI arba atskirą migraciją, NE per re-seed.
 */

interface RoomSeed {
  number: string;
  name: string;
  floor: number;
  desk_count: number;
  is_shared?: boolean;
}

const ROOMS: RoomSeed[] = [
  // ── 1 aukštas ────────────────────────────────────────────────────
  { number: '100', name: 'Asmenų aptarnavimo skyrius', floor: 1, desk_count: 2 },
  { number: '101', name: 'Viešųjų pirkimų ir turto valdymo skyrius', floor: 1, desk_count: 3 },
  { number: '102', name: 'Korupcijos prevencijos ir rizikų valdymo skyrius', floor: 1, desk_count: 3 },
  { number: '103', name: 'Būsto prieinamumo politikos grupė', floor: 1, desk_count: 3 },
  { number: '104', name: 'Kadastro ir erdvinių duomenų politikos grupė', floor: 1, desk_count: 6 },
  { number: '105', name: 'Žmonių ir organizacijos skyrius', floor: 1, desk_count: 5 },
  { number: '106', name: 'SVID / Strateginio valdymo ir tvarumo skyrius', floor: 1, desk_count: 3 },
  { number: '107', name: 'SVID / Finansų valdymo skyrius', floor: 1, desk_count: 3 },
  { number: '108', name: 'SVID / ES investicijų valdymo skyrius', floor: 1, desk_count: 1 },
  { number: '109', name: 'Architektūros ir kraštovaizdžio / Žemės ir teritorijų planavimo grupė', floor: 1, desk_count: 6 },
  { number: '110', name: 'Turto ir veiklos aprūpinimo / Dokumentų valdymo skyrius', floor: 1, desk_count: 5 },
  { number: '111', name: 'Administravimo departamentas', floor: 1, desk_count: 2 },

  // ── 2 aukštas ────────────────────────────────────────────────────
  { number: '201', name: 'Laisvas kabinetas', floor: 2, desk_count: 2 },
  { number: '203', name: 'Viceministrė', floor: 2, desk_count: 1 },
  { number: '204A', name: 'Ministras', floor: 2, desk_count: 1 },
  { number: '204', name: 'Ministro patarėjos', floor: 2, desk_count: 2 },
  { number: '205', name: 'Kancleris', floor: 2, desk_count: 1 },
  { number: '206', name: 'Centralizuoto vidaus audito skyrius', floor: 2, desk_count: 3 },
  { number: '207-1', name: 'Ministro patarėjas', floor: 2, desk_count: 1 },
  { number: '207', name: 'Ministro patarėjai', floor: 2, desk_count: 2 },
  { number: '208', name: 'Viceministrė', floor: 2, desk_count: 1 },
  { number: '209', name: 'Strateginės komunikacijos skyrius', floor: 2, desk_count: 6 },
  { number: '210', name: 'Viceministrė', floor: 2, desk_count: 1 },
  { number: '211', name: 'Teisės skyrius', floor: 2, desk_count: 4 },

  // ── 3 aukštas ────────────────────────────────────────────────────
  { number: '301', name: 'Statybos politikos grupė', floor: 3, desk_count: 3 },
  { number: '302', name: 'Taršos prevencijos politikos grupė', floor: 3, desk_count: 5 },
  { number: '303', name: 'Taršos prevencijos politikos grupė', floor: 3, desk_count: 6 },
  { number: '304', name: 'Gyvūnijos išteklių valdymo politikos grupė', floor: 3, desk_count: 3 },
  { number: '305', name: 'Europos Sąjungos ir tarptautinių ryšių grupė', floor: 3, desk_count: 10 },
  { number: '307', name: 'Atliekų politikos grupė', floor: 3, desk_count: 6 },
  { number: '308', name: 'Atliekų politikos grupė', floor: 3, desk_count: 2 },
  { number: '309', name: 'Rezervuojamos darbo vietos', floor: 3, desk_count: 4, is_shared: true },
  { number: '310', name: 'Klimato politikos grupė', floor: 3, desk_count: 5 },

  // ── 4 aukštas ────────────────────────────────────────────────────
  { number: '403', name: 'IT valdymo skyrius / Kibernetinio saugumo vadovas', floor: 4, desk_count: 5 },
  { number: '404', name: 'Informacinių sistemų vystymo skyrius', floor: 4, desk_count: 4 },
  { number: '406', name: 'Patarėjas (parengties pareigūno funkcijos)', floor: 4, desk_count: 1 },
  { number: '407', name: 'Aplinkos apsaugos politikos koordinavimo grupė', floor: 4, desk_count: 2 },
  { number: '408-1', name: 'Gamtos apsaugos politikos grupė', floor: 4, desk_count: 2 },
  { number: '408-2', name: 'Gamtos apsaugos politikos grupė', floor: 4, desk_count: 2 },
  { number: '409', name: 'Miškų politikos grupė', floor: 4, desk_count: 3 },
];

export async function seed(knex: Knex): Promise<void> {
  for (const room of ROOMS) {
    await knex('rooms')
      .insert({
        number: room.number,
        name: room.name,
        floor: room.floor,
        desk_count: room.desk_count,
        is_shared: room.is_shared ?? false,
      })
      .onConflict('number')
      .ignore();
  }
}
