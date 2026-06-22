import { describe, it, expect } from "vitest";
import { formatColorbarTick, formatColorbarTickText } from "./colorbar";

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
