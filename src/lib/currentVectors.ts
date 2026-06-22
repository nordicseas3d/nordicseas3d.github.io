export type CurrentVectorGrid = {
  lon: number[];
  lat: number[];
  u: number[][];
  v: number[][];
  z: number;
};

export type PlotlyCurrentVectors = {
  stride: number;
  x: number[];
  y: number[];
  z: number[];
  u: number[];
  v: number[];
  w: number[];
  speed: number[];
  hoverText: string[];
};

/**
 * Evenly decimate an ocean-current grid for a Plotly cone trace.
 *
 * U/V remain useful for hover as physical m/s values, while the returned cone
 * directions are normalized. Eastward velocity is converted to longitude
 * coordinate space so direction remains sensible at high latitude.
 */
export function buildPlotlyCurrentVectors(
  grid: CurrentVectorGrid,
  maxVectors: number,
  requestedStride?: number
): PlotlyCurrentVectors {
  const nx = grid.lon.length;
  const ny = grid.lat.length;
  const budget = Math.max(1, Math.floor(maxVectors));
  const out: PlotlyCurrentVectors = {
    stride: 1,
    x: [],
    y: [],
    z: [],
    u: [],
    v: [],
    w: [],
    speed: [],
    hoverText: [],
  };
  if (!nx || !ny || grid.u.length !== ny || grid.v.length !== ny) return out;

  const budgetStride = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / budget)));
  const preferredStride = Number.isFinite(Number(requestedStride))
    ? Math.max(1, Math.round(Number(requestedStride)))
    : 1;
  const stride = Math.max(budgetStride, preferredStride);
  out.stride = stride;
  const rowOffset = Math.min(ny - 1, Math.floor(stride / 2));
  const columnOffset = Math.min(nx - 1, Math.floor(stride / 2));

  for (let j = rowOffset; j < ny; j += stride) {
    if ((grid.u[j]?.length ?? 0) !== nx || (grid.v[j]?.length ?? 0) !== nx) continue;
    const latitude = Number(grid.lat[j]);
    if (!Number.isFinite(latitude)) continue;
    const cosLatitude = Math.max(0.15, Math.abs(Math.cos((latitude * Math.PI) / 180)));

    for (let i = columnOffset; i < nx; i += stride) {
      const longitude = Number(grid.lon[i]);
      const eastward = Number(grid.u[j][i]);
      const northward = Number(grid.v[j][i]);
      const speed = Math.hypot(eastward, northward);
      if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(eastward) ||
        !Number.isFinite(northward) ||
        !Number.isFinite(speed) ||
        speed <= 1e-8
      ) {
        continue;
      }

      const eastCoordinate = eastward / cosLatitude;
      const coordinateMagnitude = Math.hypot(eastCoordinate, northward);
      if (!Number.isFinite(coordinateMagnitude) || coordinateMagnitude <= 1e-8) continue;

      out.x.push(longitude);
      out.y.push(latitude);
      out.z.push(grid.z);
      out.u.push(eastCoordinate / coordinateMagnitude);
      out.v.push(northward / coordinateMagnitude);
      out.w.push(0);
      out.speed.push(speed);
      out.hoverText.push(
        `Lon ${longitude.toFixed(2)}°<br>` +
          `Lat ${latitude.toFixed(2)}°<br>` +
          `Depth ${grid.z.toFixed(0)} m<br>` +
          `Speed ${speed.toFixed(3)} m/s<br>` +
          `U ${eastward.toFixed(3)} m/s<br>` +
          `V ${northward.toFixed(3)} m/s`
      );
    }
  }

  return out;
}
