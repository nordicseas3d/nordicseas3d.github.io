function trimFormattedTick(text: string) {
  return text.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1").replace(/\.$/, "");
}

export function formatColorbarTick(value: number, title?: string) {
  if (!Number.isFinite(value)) return "";
  const label = (title ?? "").toLowerCase();
  if (label.includes("temperature")) {
    return trimFormattedTick(value.toFixed(1));
  }
  if (label.includes("salinity")) {
    return trimFormattedTick(value.toFixed(1));
  }
  if (label.includes("topograph") || label.includes("bed elevation")) {
    return trimFormattedTick(value.toFixed(0));
  }
  if (label.includes("sea ice")) {
    return trimFormattedTick(value.toFixed(Math.abs(value) >= 1 ? 1 : 2));
  }
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 1 : 2;
  return trimFormattedTick(value.toFixed(digits));
}

export function formatColorbarTickText(ticks: number[], title?: string) {
  return ticks.map((tick) => formatColorbarTick(tick, title));
}

export type ColorbarLayout = { x: number; y: number; len: number };

export function makeStackedColorbarLayouts(ids: readonly string[], compact: boolean) {
  const count = Math.max(1, ids.length);
  const len =
    count === 1
      ? compact
        ? 0.66
        : 0.78
      : count === 2
        ? 0.34
        : count === 3
          ? 0.23
          : count === 4
            ? 0.17
            : 0.13;
  const top = count <= 2 ? 0.72 : count === 3 ? 0.78 : count === 4 ? 0.82 : 0.86;
  const bottom = 1 - top;
  const x = compact ? 0.985 : 1.03;
  const fallback: ColorbarLayout = { x, y: 0.5, len };
  const slots = Object.fromEntries(
    ids.map((id, index) => [
      id,
      {
        x,
        y: count === 1 ? 0.5 : top - (index * (top - bottom)) / (count - 1),
        len,
      },
    ])
  ) as Record<string, ColorbarLayout>;
  return { slots, fallback };
}
