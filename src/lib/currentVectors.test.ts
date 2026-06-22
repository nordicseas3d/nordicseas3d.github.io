import { describe, expect, it } from "vitest";
import { buildPlotlyCurrentVectors } from "./currentVectors";

describe("buildPlotlyCurrentVectors", () => {
  it("filters missing and still water cells", () => {
    const vectors = buildPlotlyCurrentVectors(
      {
        lon: [0, 1],
        lat: [60, 61],
        u: [
          [1, Number.NaN],
          [0, 0],
        ],
        v: [
          [0, 1],
          [0, 0],
        ],
        z: -100,
      },
      4
    );

    expect(vectors.x).toEqual([0]);
    expect(vectors.speed).toEqual([1]);
    expect(vectors.z).toEqual([-100]);
  });

  it("normalizes cone directions and adjusts eastward flow for latitude", () => {
    const vectors = buildPlotlyCurrentVectors(
      {
        lon: [10],
        lat: [60],
        u: [[1]],
        v: [[1]],
        z: -25,
      },
      1
    );

    expect(Math.hypot(vectors.u[0], vectors.v[0])).toBeCloseTo(1);
    expect(vectors.u[0]).toBeGreaterThan(vectors.v[0]);
    expect(vectors.hoverText[0]).toContain("Speed 1.414 m/s");
  });

  it("honors the approximate vector budget", () => {
    const axis = Array.from({ length: 20 }, (_, i) => i);
    const values = axis.map(() => axis.map(() => 1));
    const vectors = buildPlotlyCurrentVectors(
      { lon: axis, lat: axis.map((v) => v + 50), u: values, v: values, z: 0 },
      25
    );

    expect(vectors.x.length).toBeLessThanOrEqual(25);
    expect(vectors.x.length).toBeGreaterThan(0);
  });

  it("uses a requested grid spacing when it is above the safety-budget stride", () => {
    const axis = Array.from({ length: 20 }, (_, i) => i);
    const values = axis.map(() => axis.map(() => 1));
    const vectors = buildPlotlyCurrentVectors(
      { lon: axis, lat: axis.map((v) => v + 50), u: values, v: values, z: 0 },
      400,
      5
    );

    expect(vectors.stride).toBe(5);
    expect(vectors.x.length).toBe(16);
  });
});
