// A minimal GRIB2 reader: enough to pull one grid point’s values out of a NOAA file
// that uses a regular lat/lon grid (template 3.0), a plain forecast product
// (template 4.0) and simple packing (template 5.0). Anything else throws, so a format
// change upstream fails loudly instead of returning wrong numbers.
//
// Pure functions over bytes, no Deno APIs, so it runs under Node for testing.

export type Grid = {
  ni: number; nj: number;           // points west–east, south–north
  lat1: number; lon1: number;       // first point, degrees (lon −180..180)
  di: number; dj: number;           // spacing, degrees
  bitmap: Uint8Array | null;        // 1 = has a value (water), per point; null = all
};

export type Field = {
  discipline: number; category: number; number: number;
  refTime: Date; forecastHours: number;
  grid: Grid;
  // Value at grid point (i, j), or null where the bitmap masks it out (land).
  valueAt(i: number, j: number): number | null;
};

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) + b[o + 1];
// GRIB2 signed numbers are sign-and-magnitude: the top bit is the sign.
const s32 = (b: Uint8Array, o: number) => { const v = u32(b, o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };
const s16 = (b: Uint8Array, o: number) => { const v = u16(b, o); return v & 0x8000 ? -(v & 0x7fff) : v; };

// Every field in the file. Offsets below are GRIB2 octet numbers minus one.
export function* readFields(bytes: Uint8Array): Generator<Field> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let msg = 0;
  while (msg + 16 <= bytes.length) {
    if (String.fromCharCode(...bytes.subarray(msg, msg + 4)) !== "GRIB") throw new Error(`No GRIB message at byte ${msg}`);
    if (bytes[msg + 7] !== 2) throw new Error("Not GRIB edition 2");
    const discipline = bytes[msg + 6];
    const msgLength = Number(view.getBigUint64(msg + 8));
    const end = msg + msgLength;
    let refTime = new Date(NaN), grid: Grid | null = null, bitmap: Uint8Array | null = null;
    let category = -1, number = -1, forecastHours = NaN;
    let pack: { r: number; e: number; d: number; bits: number } | null = null;
    let o = msg + 16;
    // A message can hold several fields: sections 4–7 repeat, reusing 1–3.
    while (o < end - 4) {
      const len = u32(bytes, o), sec = bytes[o + 4];
      if (sec === 1) {
        refTime = new Date(Date.UTC(u16(bytes, o + 12), bytes[o + 14] - 1, bytes[o + 15], bytes[o + 16], bytes[o + 17], bytes[o + 18]));
      } else if (sec === 3) {
        if (u16(bytes, o + 12) !== 0) throw new Error("Unsupported grid template");
        if (bytes[o + 71] !== 0x40) throw new Error("Unsupported scanning mode");
        const lon1 = u32(bytes, o + 50) / 1e6;
        grid = { ni: u32(bytes, o + 30), nj: u32(bytes, o + 34), lat1: s32(bytes, o + 46) / 1e6,
          lon1: lon1 > 180 ? lon1 - 360 : lon1, di: u32(bytes, o + 63) / 1e6, dj: u32(bytes, o + 67) / 1e6, bitmap: null };
      } else if (sec === 4) {
        if (u16(bytes, o + 7) !== 0) throw new Error("Unsupported product template");
        if (bytes[o + 17] !== 1) throw new Error("Forecast time not in hours");
        category = bytes[o + 9]; number = bytes[o + 10]; forecastHours = u32(bytes, o + 18);
      } else if (sec === 5) {
        if (u16(bytes, o + 9) !== 0) throw new Error("Unsupported packing");
        pack = { r: view.getFloat32(o + 11), e: s16(bytes, o + 15), d: s16(bytes, o + 17), bits: bytes[o + 19] };
      } else if (sec === 6) {
        const indicator = bytes[o + 5];
        if (indicator === 0) bitmap = bytes.subarray(o + 6, o + len);
        else if (indicator === 255) bitmap = null;
        else if (indicator !== 254) throw new Error("Unsupported bitmap"); // 254 reuses the last one
      } else if (sec === 7) {
        if (!grid || !pack) throw new Error("Data before its grid or packing");
        yield field(discipline, category, number, refTime, forecastHours, grid, bitmap, pack, bytes.subarray(o + 5, o + len));
      }
      o += len;
    }
    msg = end;
  }
}

function field(discipline: number, category: number, number: number, refTime: Date, forecastHours: number,
  grid: Grid, bitmap: Uint8Array | null, pack: { r: number; e: number; d: number; bits: number }, data: Uint8Array): Field {
  const has = (k: number) => !bitmap || (bitmap[k >> 3] & (0x80 >> (k & 7))) !== 0;
  // Where point k’s value sits in the data: its rank among the points that have one.
  // Counted once per field, only when a value is asked for.
  let rank: Int32Array | null = null;
  const rankOf = (k: number) => {
    if (!bitmap) return k;
    if (!rank) {
      rank = new Int32Array(grid.ni * grid.nj);
      for (let p = 0, n = 0; p < rank.length; p++) rank[p] = has(p) ? n++ : -1;
    }
    return rank[k];
  };
  const scale = 2 ** pack.e, decimal = 10 ** pack.d;
  return {
    discipline, category, number, refTime, forecastHours, grid: { ...grid, bitmap },
    valueAt(i, j) {
      const k = j * grid.ni + i;
      if (i < 0 || j < 0 || i >= grid.ni || j >= grid.nj || !has(k)) return null;
      let x = 0;
      if (pack.bits > 0) {
        const bit = rankOf(k) * pack.bits;
        for (let b = 0; b < pack.bits; b++) {
          const at = bit + b;
          x = x * 2 + ((data[at >> 3] >> (7 - (at & 7))) & 1);
        }
      }
      return (pack.r + x * scale) / decimal;
    },
  };
}

// The grid point nearest (lat, lon) that has a value, searching outward a few points
// when the nearest one is land.
export function nearestWater(f: Field, lat: number, lon: number, reach = 3): { i: number; j: number } | null {
  const { grid } = f;
  const i0 = Math.round((lon - grid.lon1) / grid.di), j0 = Math.round((lat - grid.lat1) / grid.dj);
  let best: { i: number; j: number; d: number } | null = null;
  for (let j = j0 - reach; j <= j0 + reach; j++) {
    for (let i = i0 - reach; i <= i0 + reach; i++) {
      if (f.valueAt(i, j) === null) continue;
      const dx = (grid.lon1 + i * grid.di - lon) * Math.cos(lat * Math.PI / 180), dy = grid.lat1 + j * grid.dj - lat;
      const d = dx * dx + dy * dy;
      if (!best || d < best.d) best = { i, j, d };
    }
  }
  return best && { i: best.i, j: best.j };
}
