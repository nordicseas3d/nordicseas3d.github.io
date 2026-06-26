// 3-D Lagrangian particle tracking for the Nordic Seas viewer.
//
// Pure integrator: velocity volumes are injected via a loader callback, so the
// math (interpolation + RK4) is unit-testable without any data access.
//
// Conventions:
// - lon/lat in degrees, depth in metres (negative down, like the store's Z/Zl).
// - U/V (m/s) live on cell centres (Z); W (m/s, positive up) lives on the
//   interface coordinate (Zl). Each is interpolated on its own vertical axis.
// - Volumes are Float32Array of shape [nz, ny, nx] in C order (as zarr returns).

export type Vel = { u: number; v: number; w: number };
export type PVec = { lon: number; lat: number; depth: number };
export type Sampler = (lon: number, lat: number, depth: number) => Vel | null;
export type ScalarSampler = (lon: number, lat: number, depth: number) => number | null;
export type VelVolumes = { u: Float32Array; v: Float32Array; w: Float32Array };
export type ScalarVolume = { data: Float32Array };

export type Grid = {
  lon: number[];
  lat: number[];
  z: number[]; // U/V centres (negative down, monotonic)
  zl: number[]; // W interfaces (negative down, monotonic)
  ny: number;
  nx: number;
};

const R_EARTH = 6371000; // metres
const DEG = Math.PI / 180;
const DEFAULT_MAX_STEP_SECONDS = 86400;

// Fractional index on a regular 1-D axis (ascending or descending).
// Returns null if outside the axis range.
export function fracAxis(val: number, arr: number[]): number | null {
  const n = arr.length;
  if (n < 2) return null;
  const a0 = arr[0];
  const aN = arr[n - 1];
  const lo = Math.min(a0, aN);
  const hi = Math.max(a0, aN);
  if (val < lo || val > hi) return null;
  const f = ((val - a0) / (aN - a0)) * (n - 1);
  return Math.max(0, Math.min(n - 1, f));
}

// Bracketing levels + weight for a depth on a (possibly non-uniform) vertical
// axis that is monotonic decreasing (zc[0] ~ surface, zc[n-1] ~ deepest).
export function vertBracket(depth: number, zc: number[]): { k0: number; k1: number; w: number } {
  const n = zc.length;
  if (n < 2) return { k0: 0, k1: 0, w: 0 };
  if (depth >= zc[0]) return { k0: 0, k1: 0, w: 0 };
  if (depth <= zc[n - 1]) return { k0: n - 1, k1: n - 1, w: 0 };
  for (let k = 0; k < n - 1; k++) {
    const a = zc[k];
    const b = zc[k + 1];
    if (depth <= a && depth >= b) {
      return { k0: k, k1: k + 1, w: (a - depth) / (a - b || 1e-9) };
    }
  }
  return { k0: n - 1, k1: n - 1, w: 0 };
}

function sampleScalar(
  vol: Float32Array,
  ny: number,
  nx: number,
  fi: number,
  fj: number,
  k0: number,
  k1: number,
  wk: number
): number {
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const i1 = Math.min(nx - 1, i0 + 1);
  const j1 = Math.min(ny - 1, j0 + 1);
  const fx = fi - i0;
  const fy = fj - j0;
  const plane = (k: number) => {
    const values = [
      vol[k * ny * nx + j0 * nx + i0],
      vol[k * ny * nx + j0 * nx + i1],
      vol[k * ny * nx + j1 * nx + i0],
      vol[k * ny * nx + j1 * nx + i1],
    ];
    const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    let sum = 0;
    let wsum = 0;
    for (let idx = 0; idx < values.length; idx += 1) {
      const v = values[idx];
      if (!Number.isFinite(v)) continue;
      const w = weights[idx];
      sum += v * w;
      wsum += w;
    }
    return wsum > 0 ? sum / wsum : NaN;
  };
  const a = plane(k0);
  if (k1 === k0) return a;
  const b = plane(k1);
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return a * (1 - wk) + b * wk;
}

function bracketInBand(
  b: { k0: number; k1: number; w: number },
  levelOffset: number,
  bandNz: number
): { k0: number; k1: number; w: number } | null {
  const k0 = b.k0 - levelOffset;
  const k1 = b.k1 - levelOffset;
  const inBand = (k: number) => k >= 0 && k < bandNz;
  if (Math.abs(b.w) < 1e-9 && inBand(k0)) return { k0, k1: k0, w: 0 };
  if (Math.abs(b.w - 1) < 1e-9 && inBand(k1)) return { k0: k1, k1, w: 0 };
  if (k0 < 0 || k1 < 0 || k0 >= bandNz || k1 >= bandNz) return null;
  return { k0, k1, w: b.w };
}

function bandForParticles(grid: Grid, state: PVec[], alive: boolean[], marginLevels: number) {
  let kMin = Infinity;
  let kMax = -Infinity;
  for (let i = 0; i < state.length; i += 1) {
    if (!alive[i]) continue;
    for (const b of [vertBracket(state[i].depth, grid.z), vertBracket(state[i].depth, grid.zl)]) {
      kMin = Math.min(kMin, b.k0, b.k1);
      kMax = Math.max(kMax, b.k0, b.k1);
    }
  }
  if (!Number.isFinite(kMin) || !Number.isFinite(kMax)) return null;
  const nz = grid.z.length;
  return {
    k0: Math.max(0, Math.floor(kMin) - marginLevels),
    k1: Math.min(nz, Math.ceil(kMax) + marginLevels + 1),
  };
}

// Trilinear (space) + linear (time) sampler over two snapshots; `wt` is the
// weight of volB (the second snapshot).
//
// `levelOffset`/`bandNz` support loading only a vertical band of levels (an
// optimization): the volumes hold levels [levelOffset, levelOffset+bandNz), and
// samples outside that loaded band are rejected instead of clamped to an edge.
export function makeSampler(
  grid: Grid,
  volA: VelVolumes,
  volB: VelVolumes,
  wt: number,
  levelOffset = 0,
  bandNz = grid.z.length
): Sampler {
  const { lon, lat, z, zl, ny, nx } = grid;
  return (plon, plat, pdepth) => {
    const fi = fracAxis(plon, lon);
    const fj = fracAxis(plat, lat);
    if (fi == null || fj == null) return null;
    const bz = bracketInBand(vertBracket(pdepth, z), levelOffset, bandNz);
    const bzl = bracketInBand(vertBracket(pdepth, zl), levelOffset, bandNz);
    if (!bz || !bzl) return null;
    const uA = sampleScalar(volA.u, ny, nx, fi, fj, bz.k0, bz.k1, bz.w);
    const vA = sampleScalar(volA.v, ny, nx, fi, fj, bz.k0, bz.k1, bz.w);
    const wA = sampleScalar(volA.w, ny, nx, fi, fj, bzl.k0, bzl.k1, bzl.w);
    const uB = sampleScalar(volB.u, ny, nx, fi, fj, bz.k0, bz.k1, bz.w);
    const vB = sampleScalar(volB.v, ny, nx, fi, fj, bz.k0, bz.k1, bz.w);
    const wB = sampleScalar(volB.w, ny, nx, fi, fj, bzl.k0, bzl.k1, bzl.w);
    if (
      !Number.isFinite(uA) ||
      !Number.isFinite(vA) ||
      !Number.isFinite(wA) ||
      !Number.isFinite(uB) ||
      !Number.isFinite(vB) ||
      !Number.isFinite(wB)
    ) {
      return null;
    }
    return {
      u: uA * (1 - wt) + uB * wt,
      v: vA * (1 - wt) + vB * wt,
      w: wA * (1 - wt) + wB * wt,
    };
  };
}

export function makeScalarSampler(
  grid: Grid,
  volume: ScalarVolume,
  levelOffset = 0,
  bandNz = grid.z.length
): ScalarSampler {
  const { lon, lat, z, ny, nx } = grid;
  return (plon, plat, pdepth) => {
    const fi = fracAxis(plon, lon);
    const fj = fracAxis(plat, lat);
    if (fi == null || fj == null) return null;
    const bz = bracketInBand(vertBracket(pdepth, z), levelOffset, bandNz);
    if (!bz) return null;
    const sample = sampleScalar(volume.data, ny, nx, fi, fj, bz.k0, bz.k1, bz.w);
    return Number.isFinite(sample) ? sample : null;
  };
}

function deriv(p: PVec, s: Sampler, dir: number): { dlon: number; dlat: number; ddep: number } | null {
  const vel = s(p.lon, p.lat, p.depth);
  if (!vel) return null;
  const cosphi = Math.max(0.02, Math.cos(p.lat * DEG));
  return {
    dlon: (dir * vel.u) / (R_EARTH * cosphi * DEG), // deg/s
    dlat: (dir * vel.v) / (R_EARTH * DEG), // deg/s
    ddep: dir * vel.w, // m/s (positive up -> depth increases toward 0)
  };
}

// One RK4 step of `dtSec` seconds. `dir` = +1 forward, -1 backward in time.
// Returns the next position, or null if the path left the (wet) domain.
export function rk4Step(p: PVec, dtSec: number, s: Sampler, dir: number): PVec | null {
  const k1 = deriv(p, s, dir);
  if (!k1) return null;
  const k2 = deriv(
    { lon: p.lon + 0.5 * dtSec * k1.dlon, lat: p.lat + 0.5 * dtSec * k1.dlat, depth: p.depth + 0.5 * dtSec * k1.ddep },
    s,
    dir
  );
  if (!k2) return null;
  const k3 = deriv(
    { lon: p.lon + 0.5 * dtSec * k2.dlon, lat: p.lat + 0.5 * dtSec * k2.dlat, depth: p.depth + 0.5 * dtSec * k2.ddep },
    s,
    dir
  );
  if (!k3) return null;
  const k4 = deriv(
    { lon: p.lon + dtSec * k3.dlon, lat: p.lat + dtSec * k3.dlat, depth: p.depth + dtSec * k3.ddep },
    s,
    dir
  );
  if (!k4) return null;
  let depth = p.depth + (dtSec / 6) * (k1.ddep + 2 * k2.ddep + 2 * k3.ddep + k4.ddep);
  if (depth > 0) depth = 0; // don't rise above the surface
  return {
    lon: p.lon + (dtSec / 6) * (k1.dlon + 2 * k2.dlon + 2 * k3.dlon + k4.dlon),
    lat: p.lat + (dtSec / 6) * (k1.dlat + 2 * k2.dlat + 2 * k3.dlat + k4.dlat),
    depth,
  };
}

export type IntegrateOpts = {
  grid: Grid;
  seeds: PVec[];
  tStart: number; // start snapshot index
  nSnapshots: number;
  snapshotSeconds: number; // seconds between available velocity snapshots
  runDays: number;
  direction: 1 | -1;
  loadVolumes: (tIndex: number, k0: number, k1: number) => Promise<VelVolumes>;
  bandMarginLevels?: number;
  maxStepSeconds?: number;
  onProgress?: (fraction: number) => void;
};

export type Trajectory = { points: PVec[]; beached: boolean };

// Integrate trajectories by streaming snapshot pairs through time.
export async function integrateTrajectories(opts: IntegrateOpts): Promise<Trajectory[]> {
  const { grid, seeds, tStart, nSnapshots, snapshotSeconds, runDays, direction, loadVolumes } = opts;
  const marginLevels = Math.max(0, Math.round(opts.bandMarginLevels ?? 12));
  const dtSec = Math.max(
    1,
    Math.min(snapshotSeconds, opts.maxStepSeconds ?? Math.min(snapshotSeconds, DEFAULT_MAX_STEP_SECONDS))
  );
  const totalSec = Math.max(0, runDays) * 86400;
  const trajs: Trajectory[] = seeds.map((s) => ({ points: [{ ...s }], beached: false }));
  const state = seeds.map((s) => ({ ...s }));
  const alive = seeds.map(() => true);

  let elapsed = 0;
  let tk = Math.max(0, Math.min(nSnapshots - 1, tStart));
  while (elapsed < totalSec) {
    const tkNext = tk + direction;
    if (tkNext < 0 || tkNext >= nSnapshots) break; // out of available data
    const band = bandForParticles(grid, state, alive, marginLevels);
    if (!band) break;
    const [volA, volB] = await Promise.all([
      loadVolumes(tk, band.k0, band.k1),
      loadVolumes(tkNext, band.k0, band.k1),
    ]);
    let segSec = 0;
    while (segSec < snapshotSeconds && elapsed < totalSec) {
      const step = Math.min(dtSec, snapshotSeconds - segSec, totalSec - elapsed);
      const wt = (segSec + step * 0.5) / snapshotSeconds; // midpoint weight
      const sampler = makeSampler(grid, volA, volB, wt, band.k0, band.k1 - band.k0);
      for (let p = 0; p < state.length; p++) {
        if (!alive[p]) continue;
        const next = rk4Step(state[p], step, sampler, direction);
        if (!next) {
          alive[p] = false;
          trajs[p].beached = true;
          continue;
        }
        state[p] = next;
        trajs[p].points.push({ ...next });
      }
      segSec += step;
      elapsed += step;
    }
    tk = tkNext;
    opts.onProgress?.(Math.min(1, elapsed / totalSec));
  }
  return trajs;
}
