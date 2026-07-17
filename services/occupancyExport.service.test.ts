import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildOccupancyWorkbook,
  resolveRange,
  eachDay,
  type FloorCapacityRow,
  type ReservedRow,
} from './occupancyExport.service';

const capacities: FloorCapacityRow[] = [
  { floor: 1, total: 10 },
  { floor: 2, total: 20 },
];
// Iš viso 30 vietų.

async function reload(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buf = await wb.xlsx.writeBuffer();
  const fresh = new ExcelJS.Workbook();
  await fresh.xlsx.load(buf as Buffer);
  return fresh;
}

describe('resolveRange', () => {
  it('day = ta pati diena', () => {
    expect(resolveRange('day', '2026-07-15')).toEqual({ from: '2026-07-15', to: '2026-07-15' });
  });
  it('week = pirmadienis..sekmadienis (2026-07-15 = trečiadienis)', () => {
    expect(resolveRange('week', '2026-07-15')).toEqual({ from: '2026-07-13', to: '2026-07-19' });
  });
  it('week kai data sekmadienis (2026-07-19)', () => {
    expect(resolveRange('week', '2026-07-19')).toEqual({ from: '2026-07-13', to: '2026-07-19' });
  });
  it('month = 1 d. .. paskutinė d.', () => {
    expect(resolveRange('month', '2026-07-15')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });
  it('month vasaris keliamieji (2028)', () => {
    expect(resolveRange('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
});

describe('eachDay', () => {
  it('grąžina imtinį intervalą', () => {
    expect(eachDay('2026-07-13', '2026-07-15')).toEqual(['2026-07-13', '2026-07-14', '2026-07-15']);
  });
  it('viena diena', () => {
    expect(eachDay('2026-07-13', '2026-07-13')).toEqual(['2026-07-13']);
  });
});

describe('buildOccupancyWorkbook', () => {
  it('dienos užimtumas skaičiuojamas teisingai (15/30 = 50%)', async () => {
    const reserved: ReservedRow[] = [
      { date: '2026-07-15', floor: 1, reserved: 5 },
      { date: '2026-07-15', floor: 2, reserved: 10 },
    ];
    const wb = await reload(buildOccupancyWorkbook('day', '2026-07-15', '2026-07-15', capacities, reserved));
    const sum = wb.getWorksheet('Suvestinė')!;
    // eilutė 4 = pirma dienos eilutė (1 antraštė, 2 laikotarpis, 3 stulpelių antraštė)
    expect(sum.getCell('C4').value).toBe(15);
    expect(Number(sum.getCell('D4').value)).toBeCloseTo(0.5, 5);
  });

  it('savaitgaliai praleidžiami pagal nutylėjimą', async () => {
    // 2026-07-13 (Pr) .. 2026-07-19 (Sk) -> tik 5 darbo dienos
    const wb = await reload(buildOccupancyWorkbook('week', '2026-07-13', '2026-07-19', capacities, []));
    const sum = wb.getWorksheet('Suvestinė')!;
    // eilutės: 1,2,3 antraštės; 5 darbo dienų; +1 vidurkis = iki 9-tos
    const dates: string[] = [];
    for (let r = 4; r <= 8; r++) dates.push(String(sum.getCell(`A${r}`).value));
    expect(dates).toEqual(['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']);
    expect(String(sum.getCell('A9').value)).toBe('Vidurkis');
  });

  it('includeWeekends=true įtraukia savaitgalius', async () => {
    const wb = await reload(
      buildOccupancyWorkbook('week', '2026-07-13', '2026-07-19', capacities, [], { includeWeekends: true }),
    );
    const sum = wb.getWorksheet('Suvestinė')!;
    // 7 dienos + vidurkis -> vidurkis 11-toje eilutėje
    expect(String(sum.getCell('A11').value)).toBe('Vidurkis');
  });

  it('sheet "Pagal aukštą" turi stulpelį kiekvienam aukštui', async () => {
    const reserved: ReservedRow[] = [{ date: '2026-07-15', floor: 2, reserved: 10 }];
    const wb = await reload(buildOccupancyWorkbook('day', '2026-07-15', '2026-07-15', capacities, reserved));
    const bf = wb.getWorksheet('Pagal aukštą')!;
    // antraštės eilutė = 2: A2=Data, B2=1 a., C2=2 a.
    expect(String(bf.getCell('A2').value)).toBe('Data');
    expect(String(bf.getCell('B2').value)).toContain('1 a.');
    expect(String(bf.getCell('C2').value)).toContain('2 a.');
    // 2 a.: 10/20 = 50%
    expect(Number(bf.getCell('C3').value)).toBeCloseTo(0.5, 5);
    // 1 a.: 0/10 = 0%
    expect(Number(bf.getCell('B3').value)).toBeCloseTo(0, 5);
  });

  it('nulinė kapacitetė neįsprogsta (dalyba iš nulio -> 0%)', async () => {
    const wb = await reload(
      buildOccupancyWorkbook('day', '2026-07-15', '2026-07-15', [{ floor: 1, total: 0 }], []),
    );
    const sum = wb.getWorksheet('Suvestinė')!;
    expect(Number(sum.getCell('D4').value)).toBe(0);
  });
});
