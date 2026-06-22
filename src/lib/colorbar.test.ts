import { describe, it, expect } from "vitest";
import {
  formatColorbarTick,
  formatColorbarTickText,
  makeStackedColorbarLayouts,
} from "./colorbar";

// Starter unit test to establish the test harness. Expand coverage to the other
// pure helpers (colormap, eddies math, gsZarr.nearestIndex) over time.
describe("formatColorbarTick", () => {
  it("trims trailing zeros", () => {
    expect(formatColorbarTick(1.0, "Temperature")).toBe("1");
    expect(formatColorbarTick(2.5, "Temperature")).toBe("2.5");
  });

  it("returns an empty string for non-finite values", () => {
    expect(formatColorbarTick(NaN)).toBe("");
    expect(formatColorbarTick(Infinity)).toBe("");
  });

  it("rounds topography to whole meters", () => {
    expect(formatColorbarTick(-1234.6, "Topography")).toBe("-1235");
  });

  it("formats a list of ticks", () => {
    expect(formatColorbarTickText([1.0, 2.5], "Temperature")).toEqual(["1", "2.5"]);
  });
});

describe("makeStackedColorbarLayouts", () => {
  it("assigns distinct, non-overlapping slots to every active scale", () => {
    for (let count = 1; count <= 5; count++) {
      const ids = Array.from({ length: count }, (_, index) => `bar-${index}`);
      const { slots } = makeStackedColorbarLayouts(ids, false);
      const layouts = ids.map((id) => slots[id]);

      expect(new Set(layouts.map((layout) => layout.y)).size).toBe(count);
      for (let index = 1; index < layouts.length; index++) {
        const separation = Math.abs(layouts[index - 1].y - layouts[index].y);
        expect(separation).toBeGreaterThan(layouts[index].len);
      }
    }
  });

  it("keeps compact layouts inside the plot area", () => {
    const ids = ["primary", "eta", "seaIce"];
    const { slots } = makeStackedColorbarLayouts(ids, true);
    expect(ids.every((id) => slots[id].x < 1)).toBe(true);
    expect(ids.every((id) => slots[id].y > 0 && slots[id].y < 1)).toBe(true);
  });
});
