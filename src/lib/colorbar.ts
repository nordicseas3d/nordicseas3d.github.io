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
