import { describe, it, expect } from "vitest";
import {
  fracAxis,
  vertBracket,
  makeSampler,
  makeScalarSampler,
  rk4Step,
  integrateTrajectories,
  type Grid,
  type VelVolumes,
} from "./particles";

const R = 6371000;
const DEG = Math.PI / 180;

const nx = 5;
const ny = 4;
const nz = 3;
const grid: Grid = {
  lon: [0, 1, 2, 3, 4],
  lat: [60, 61, 62, 63],
  z: [-5, -50, -200],
  zl: [-10, -100, -400],
  ny,
  nx,
};
const fill = (v: number) => {
  const a = new Float32Array(nz * ny * nx);
  a.fill(v);
  return a;
};
const vols = (u: number, v: number, w: number): VelVolumes => ({
  u: fill(u),
  v: fill(v),
  w: fill(w),
});
const sliceVols = (v: VelVolumes, k0: number, k1: number): VelVolumes => {
  const a = k0 * ny * nx;
  const b = k1 * ny * nx;
  return {
    u: v.u.slice(a, b),
    v: v.v.slice(a, b),
    w: v.w.slice(a, b),
  };
};
const withOneDryNeighbor = () => {
  const v = vols(0.1, 0, 0);
  const dry = 1 * ny * nx + 1 * nx + 1;
  v.u[dry] = NaN;
  v.v[dry] = NaN;
  v.w[dry] = NaN;
  return v;
};

describe("axis helpers", () => {
  it("fracAxis maps and rejects out-of-range", () => {
    expect(fracAxis(2, grid.lon)).toBeCloseTo(2, 9);
    expect(fracAxis(9, grid.lon)).toBeNull();
  });
  it("vertBracket brackets a depth between centres", () => {
    const b = vertBracket(-50, grid.z);
    expect(b.k0).toBe(0);
    expect(b.k1).toBe(1);
    expect(b.w).toBeCloseTo(1, 6);
  });
});

describe("rk4Step", () => {
  it("advects east at the metric-correct rate", () => {
    const s = makeSampler(grid, vols(0.1, 0, 0), vols(0.1, 0, 0), 0.5);
    const dt = 3600;
    const next = rk4Step({ lon: 2, lat: 61.5, depth: -50 }, dt, s, 1)!;
    const expected = 2 + (0.1 / (R * Math.cos(61.5 * DEG) * DEG)) * dt;
    expect(next.lon).toBeCloseTo(expected, 6);
    expect(next.lat).toBeCloseTo(61.5, 9);
  });
  it("returns null off the wet domain", () => {
    const s = makeSampler(grid, vols(NaN, NaN, NaN), vols(NaN, NaN, NaN), 0.5);
    expect(rk4Step({ lon: 2, lat: 61.5, depth: -50 }, 3600, s, 1)).toBeNull();
  });
  it("does not clamp samples onto a loaded vertical band edge", () => {
    const sameZGrid = { ...grid, zl: grid.z };
    const band = sliceVols(vols(0.1, 0, 0), 1, 2);
    const s = makeSampler(sameZGrid, band, band, 0.5, 1, 1);
    expect(s(2, 61.5, -50)).not.toBeNull();
    expect(s(2, 61.5, -5)).toBeNull();
  });
  it("samples from wet neighbors instead of beaching on one dry neighbor", () => {
    const sameZGrid = { ...grid, zl: grid.z };
    const v = withOneDryNeighbor();
    const s = makeSampler(sameZGrid, v, v, 0.5);
    const sampled = s(1.2, 61.2, -50);
    expect(sampled).not.toBeNull();
    expect(sampled?.u).toBeCloseTo(0.1, 6);
  });
  it("samples scalar fields with the same wet-neighbor interpolation", () => {
    const data = fill(4);
    data[1 * ny * nx + 1 * nx + 1] = NaN;
    const s = makeScalarSampler(grid, { data });
    expect(s(1.2, 61.2, -50)).toBeCloseTo(4, 6);
    expect(s(9, 61.2, -50)).toBeNull();
  });
});

describe("integrateTrajectories", () => {
  const loader = (v: VelVolumes) => async (_t: number, k0: number, k1: number) =>
    sliceVols(v, k0, k1);

  it("traces a straight eastward path in a steady field", async () => {
    const trajs = await integrateTrajectories({
      grid,
      seeds: [{ lon: 2, lat: 61.5, depth: -50 }],
      tStart: 0,
      nSnapshots: 5,
      snapshotSeconds: 86400,
      runDays: 1,
      direction: 1,
      loadVolumes: loader(vols(0.1, 0, 0)),
    });
    const t = trajs[0];
    expect(t.beached).toBe(false);
    expect(t.points.length).toBeGreaterThan(1);
    const expected = 2 + (0.1 / (R * Math.cos(61.5 * DEG) * DEG)) * 86400;
    expect(t.points[t.points.length - 1].lon).toBeCloseTo(expected, 3);
  });

  it("beaches a particle in a land (NaN) field", async () => {
    const trajs = await integrateTrajectories({
      grid,
      seeds: [{ lon: 2, lat: 61.5, depth: -50 }],
      tStart: 0,
      nSnapshots: 5,
      snapshotSeconds: 86400,
      runDays: 1,
      direction: 1,
      loadVolumes: loader(vols(NaN, NaN, NaN)),
    });
    expect(trajs[0].beached).toBe(true);
  });

  it("substeps within a snapshot interval when requested", async () => {
    const trajs = await integrateTrajectories({
      grid,
      seeds: [{ lon: 2, lat: 61.5, depth: -50 }],
      tStart: 0,
      nSnapshots: 2,
      snapshotSeconds: 2 * 86400,
      maxStepSeconds: 86400,
      runDays: 2,
      direction: 1,
      loadVolumes: loader(vols(0.1, 0, 0)),
    });
    expect(trajs[0].points.length).toBe(3);
  });
});
