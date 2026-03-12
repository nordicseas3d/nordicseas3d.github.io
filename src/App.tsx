import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Basemap3D from "./components/Basemap3D";
import {
  balance_256,
  blues_r_256,
  deep_256,
  grayscale_256,
  haline_256,
  ice_256,
  paletteToColorscale,
  plasma_256,
  rdylbu_r_256,
  thermal_256,
  topo_256,
  viridis_256,
  type RGB,
} from "./lib/colormap";
import {
  loadGsZarrMeta,
  load3DFieldAtTime,
  loadHorizontalSlice,
  loadSeaIce2D,
  loadWindStress2D,
  loadTransectSlice,
  nearestIndex,
  type GsZarrMeta,
} from "./lib/gsZarr";
import {
  buildEddyVolume,
  detectAndTrackEddies,
  type EddyDetectionResult,
  type EddyVolumeCluster,
} from "./lib/eddies";

type ViewMode = "horizontal" | "transect" | "draw" | "class" | "eddies";
type VarId = "T" | "S";
type ColorscaleMode = "continuous" | "discrete";
type FieldColormapId = "thermal" | "haline" | "balance" | "rdylbu_r" | "viridis" | "plasma";
type BathyColormapId = "deep" | "topo" | "blues_r" | "viridis" | "haline" | "grayscale";

type VarColorSettings = {
  cmin: number;
  cmax: number;
  tickCount: number; // 0 => auto
  mode: ColorscaleMode;
  levels: number; // used when mode === "discrete"
};

type ClassSettings = {
  min: number;
  max: number;
  interval: number;
  halfWidth: number;
};

type ClassInputSettings = {
  min: string;
  max: string;
};

type HorizontalGrid = {
  values: number[][];
  lon: number[];
  lat: number[];
};

type TransectGrid = {
  values: number[][];
  lon: number[];
  lat: number[];
  z: number[];
  distanceKm: number[];
};

type VectorGrid = {
  u: number[][];
  v: number[][];
  lon: number[];
  lat: number[];
};

type LonLatPoint = {
  lon: number;
  lat: number;
};

type TransectPathSpec = {
  lon: number[];
  lat: number[];
  distanceKm: number[];
  totalDistanceKm: number;
};

type ClassTrace = {
  label: string;
  value: number;
  x: number[];
  y: number[];
  z: number[];
};

type EddyClusterRender = {
  id: string;
  kind: "warm" | "cold";
  x: number[];
  y: number[];
  z: number[];
  trackX: number[];
  trackY: number[];
  trackZ: number[];
  hoverText: string;
};

const VIEW_MODE_DESCRIPTIONS: Record<Exclude<ViewMode, "eddies">, string> = {
  horizontal:
    "Horizontal: view the selected variable on a constant-depth map slice. Select depth under Slice, define color scheme under Color scale.",
  transect:
    "Zonal: view the selected variable on a west-east section at a chosen latitude. Select latitude under Slice, define color scheme under Color scale.",
  draw:
    "Draw: sample the selected variable along an arbitrary line between two map points. Set depth and draw the line under Slice, define color scheme under Color scale.",
  class:
    "Class: show 3D point clouds for value bands through the water column. Set class range and density under Slice, define color scheme under Color scale.",
};

const PLAYBACK_SURFACE_MAX = 180;
const PLAYBACK_TRANSECT_LON_MAX = 220;
const PLAYBACK_TRANSECT_DEPTH_MAX = 110;
const PLAYBACK_SEA_ICE_MAX = 150;
const PLAYBACK_WIND_MAX = 110;
const DRAW_TRANSECT_SAMPLES_PLAYING = 96;
const DRAW_TRANSECT_SAMPLES_PAUSED = 156;
const CLASS_MAX_XY_PLAYING = 70;
const CLASS_MAX_XY_PAUSED = 110;
const CLASS_MAX_Z_PLAYING = 24;
const CLASS_MAX_Z_PAUSED = 36;
const CLASS_POINTS_PER_CLASS_PLAYING = 700;
const CLASS_POINTS_PER_CLASS_PAUSED = 1400;
const CLASS_DENSITY_DEFAULT = 1;
const CLASS_DENSITY_MIN = 0.35;
const CLASS_DENSITY_MAX = 1.6;
const CLASS_DENSITY_STEP = 0.05;
const CLASS_DENSITY_STORAGE_KEY = "gs_class_density_v1";
const EDDY_POINTS_PER_CLUSTER_PLAYING = 180;
const EDDY_POINTS_PER_CLUSTER_PAUSED = 320;
const EDDY_LAYER_OFFSET_M = 8;
const EDDY_TRACK_OFFSET_M = 18;
const EDDY_DETECTION_DEPTH_M = -1000;
const EDDY_TRACK_HISTORY_DEFAULT = 6;
const EDDY_TRACK_HISTORY_MAX = 12;
const EDDY_MIN_CELLS_DEFAULT = 18;
const EDDY_VOLUME_DEPTH_SAMPLES_PLAYING = 16;
const EDDY_VOLUME_DEPTH_SAMPLES_PAUSED = 28;
const EDDY_VOLUME_POINTS_PER_CLUSTER_PLAYING = 700;
const EDDY_VOLUME_POINTS_PER_CLUSTER_PAUSED = 1400;
const EDDY_THRESHOLD_DEFAULT: Record<VarId, number> = {
  T: 0.15,
  S: 0.03,
};
const BOREAS_BASIN_BOUNDS = {
  lonMin: -30,
  lonMax: 23,
  latMin: 57.670002,
  latMax: 81.49752,
};
const GSR_MASK_STORAGE_KEY = "gs_gsr_mask_v1";
const GREENLAND_SEA_MASK_STORAGE_KEY = "gs_greenland_sea_mask_v1";
const ICELAND_SEA_MASK_STORAGE_KEY = "gs_iceland_sea_mask_v1";
const NORWEGIAN_SEA_MASK_STORAGE_KEY = "gs_norwegian_sea_mask_v1";
const GSR_DIVIDER = [
  { lon: -30, lat: 69.0 },
  { lon: -28, lat: 69.0 },
  { lon: -20, lat: 66.0 },
  { lon: -19.9, lat: 65.65 },
  { lon: -14, lat: 65.0 },
  { lon: -7, lat: 62.3 },
  { lon: -1.3, lat: 60.5 },
  { lon: 6, lat: 60.5 },
  { lon: 23, lat: 60.5 },
] as const;
const GREENLAND_ICELAND_DIVIDER = [
  { lon: -30.0, lat: 71.06 },
  { lon: -8.17, lat: 71.06 },
] as const;
const NORWEGIAN_SEA_DIVIDER = [
  { lon: -8.17, lat: 63.5 },
  { lon: -8.17, lat: 71.06 },
  { lon: 8.0, lat: 73.5 },
  { lon: 6.0, lat: 78.3 },
  // Fram Strait: follow the Molloy/Fram saddle northward along the
  // western flank of the Yermak-Spitsbergen topographic rise.
  { lon: 5.0, lat: 78.55 },
  { lon: 4.0, lat: 78.8 },
  { lon: 3.1, lat: 79.05 },
  { lon: 2.4, lat: 79.25 },
  { lon: 1.9, lat: 79.5 },
  { lon: 1.6, lat: 79.8 },
  { lon: 1.45, lat: 80.1 },
  { lon: 1.35, lat: 80.45 },
  { lon: 1.15, lat: 80.8 },
  { lon: 0.95, lat: 81.15 },
  { lon: 0.8, lat: 81.49752 },
] as const;

type SpatialMaskState = {
  gsr: boolean;
  greenlandSea: boolean;
  icelandSea: boolean;
  norwegianSea: boolean;
};
type SubdomainId = "gsr" | "greenlandSea" | "icelandSea" | "norwegianSea";

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

function defaultRange(varId: VarId) {
  if (varId === "T") return { min: -1, max: 8, ticks: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8], title: "Temperature (°C)" };
  return {
    min: 34,
    max: 35.6,
    ticks: [34, 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.7, 34.8, 34.9, 35, 35.1, 35.2, 35.3, 35.4, 35.5, 35.6],
    title: "Salinity (g/kg)",
  };
}

function inBoreasBasin(lon: number, lat: number) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= BOREAS_BASIN_BOUNDS.lonMin &&
    lon <= BOREAS_BASIN_BOUNDS.lonMax &&
    lat >= BOREAS_BASIN_BOUNDS.latMin &&
    lat <= BOREAS_BASIN_BOUNDS.latMax
  );
}

function interpLatByLon(points: ReadonlyArray<{ lon: number; lat: number }>, lon: number) {
  if (!Number.isFinite(lon)) return Number.NaN;
  if (lon <= points[0].lon) return points[0].lat;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (lon <= b.lon) {
      const span = b.lon - a.lon;
      if (span <= 1e-9) return b.lat;
      const t = (lon - a.lon) / span;
      return a.lat + t * (b.lat - a.lat);
    }
  }
  return points[points.length - 1].lat;
}

function interpLonByLat(points: ReadonlyArray<{ lon: number; lat: number }>, lat: number) {
  if (!Number.isFinite(lat)) return Number.NaN;
  if (lat <= points[0].lat) return points[0].lon;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (lat <= b.lat) {
      const span = b.lat - a.lat;
      if (span <= 1e-9) return b.lon;
      const t = (lat - a.lat) / span;
      return a.lon + t * (b.lon - a.lon);
    }
  }
  return points[points.length - 1].lon;
}

function classifyNordicSubdomain(lon: number, lat: number): SubdomainId {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return "gsr";
  const gsrLat = interpLatByLon(GSR_DIVIDER, lon);
  if (lat < gsrLat) return "gsr";

  const norwegianBoundaryLon = interpLonByLat(NORWEGIAN_SEA_DIVIDER, lat);
  if (lon >= norwegianBoundaryLon) return "norwegianSea";

  const greenlandIcelandLat = interpLatByLon(GREENLAND_ICELAND_DIVIDER, lon);
  if (lat <= greenlandIcelandLat) return "icelandSea";
  return "greenlandSea";
}

function hasAnyMaskEnabled(mask: SpatialMaskState) {
  return mask.gsr || mask.greenlandSea || mask.icelandSea || mask.norwegianSea;
}

function pointPassesSpatialMask(lon: number, lat: number, mask: SpatialMaskState) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (!hasAnyMaskEnabled(mask)) return true;
  const subdomain = classifyNordicSubdomain(lon, lat);
  if (subdomain === "gsr") return !mask.gsr;
  if (subdomain === "greenlandSea") return !mask.greenlandSea;
  if (subdomain === "icelandSea") return !mask.icelandSea;
  return !mask.norwegianSea;
}

function applySpatialMaskToHorizontal(values: number[][], lon: number[], lat: number[], mask: SpatialMaskState) {
  if (!hasAnyMaskEnabled(mask)) return values;
  const ny = values.length;
  const nx = values[0]?.length ?? 0;
  if (!ny || !nx || lon.length !== nx || lat.length !== ny) return values;
  const out: number[][] = new Array(ny);
  for (let j = 0; j < ny; j++) {
    const row = values[j];
    const y = Number(lat[j]);
    const nextRow = new Array<number>(nx);
    for (let i = 0; i < nx; i++) {
      nextRow[i] = pointPassesSpatialMask(Number(lon[i]), y, mask) ? Number(row[i]) : Number.NaN;
    }
    out[j] = nextRow;
  }
  return out;
}

function applySpatialMaskToTransect(
  values: number[][],
  lon: number[],
  lat: number | number[],
  mask: SpatialMaskState
) {
  if (!hasAnyMaskEnabled(mask)) return values;
  const nz = values.length;
  const nx = values[0]?.length ?? 0;
  const latValues = Array.isArray(lat) ? lat : lon.map(() => lat);
  if (!nz || !nx || lon.length !== nx || latValues.length !== nx) return values;
  const keep = lon.map((x, i) => pointPassesSpatialMask(Number(x), Number(latValues[i]), mask));
  const out: number[][] = new Array(nz);
  for (let k = 0; k < nz; k++) {
    const row = values[k];
    const nextRow = new Array<number>(nx);
    for (let i = 0; i < nx; i++) nextRow[i] = keep[i] ? Number(row[i]) : Number.NaN;
    out[k] = nextRow;
  }
  return out;
}

function applySpatialMaskToVectorGrid(
  field: { u: number[][]; v: number[][] },
  lon: number[],
  lat: number[],
  mask: SpatialMaskState
) {
  if (!hasAnyMaskEnabled(mask)) return field;
  const ny = field.u.length;
  const nx = field.u[0]?.length ?? 0;
  if (!ny || !nx || field.v.length !== ny || lon.length !== nx || lat.length !== ny) return field;
  const u: number[][] = new Array(ny);
  const v: number[][] = new Array(ny);
  for (let j = 0; j < ny; j++) {
    const uRow = field.u[j];
    const vRow = field.v[j];
    const y = Number(lat[j]);
    const nextU = new Array<number>(nx);
    const nextV = new Array<number>(nx);
    for (let i = 0; i < nx; i++) {
      if (pointPassesSpatialMask(Number(lon[i]), y, mask)) {
        nextU[i] = Number(uRow[i]);
        nextV[i] = Number(vRow[i]);
      } else {
        nextU[i] = Number.NaN;
        nextV[i] = Number.NaN;
      }
    }
    u[j] = nextU;
    v[j] = nextV;
  }
  return { u, v };
}

const FIELD_COLORMAP_OPTIONS: Array<{ id: FieldColormapId; label: string }> = [
  { id: "thermal", label: "cmocean thermal" },
  { id: "haline", label: "cmocean haline" },
  { id: "balance", label: "cmocean balance" },
  { id: "rdylbu_r", label: "RdYlBu_r" },
  { id: "viridis", label: "Viridis" },
  { id: "plasma", label: "Plasma" },
];

const BATHY_COLORMAP_OPTIONS: Array<{ id: BathyColormapId; label: string }> = [
  { id: "deep", label: "cmocean deep" },
  { id: "topo", label: "cmocean topo" },
  { id: "grayscale", label: "Grayscale" },
  { id: "blues_r", label: "Blues_r" },
  { id: "viridis", label: "Viridis" },
  { id: "haline", label: "cmocean haline" },
];

const DEFAULT_FIELD_COLORMAP: Record<VarId, FieldColormapId> = {
  T: "rdylbu_r",
  S: "rdylbu_r",
};

const DEFAULT_BATHY_COLORMAP: BathyColormapId = "topo";

function paletteForColormapId(id: FieldColormapId | BathyColormapId): RGB[] {
  switch (id) {
    case "thermal":
      return thermal_256();
    case "haline":
      return haline_256();
    case "balance":
      return balance_256();
    case "rdylbu_r":
      return rdylbu_r_256();
    case "viridis":
      return viridis_256();
    case "plasma":
      return plasma_256();
    case "deep":
      return deep_256();
    case "topo":
      return topo_256();
    case "grayscale":
      return grayscale_256();
    case "blues_r":
      return blues_r_256();
    default:
      return thermal_256();
  }
}

const FALLBACK_FIELD_PALETTE = thermal_256();
const FALLBACK_FIELD_CONTINUOUS = paletteToColorscale(FALLBACK_FIELD_PALETTE);

const DEFAULT_COLOR_SETTINGS: Record<VarId, VarColorSettings> = {
  T: { cmin: -1, cmax: 8, tickCount: 10, mode: "continuous", levels: 12 },
  S: { cmin: 34, cmax: 35.6, tickCount: 17, mode: "continuous", levels: 12 },
};

const TICK_OPTIONS_BY_VAR: Record<VarId, number[]> = {
  T: [5, 7, 9, 10, 11, 13],
  S: [5, 7, 9, 11, 13, 15, 17, 21, 25],
};

const DEFAULT_CLASS_SETTINGS: Record<VarId, ClassSettings> = {
  T: { min: -1, max: 8, interval: 1, halfWidth: 0.5 },
  S: { min: 34, max: 35.6, interval: 0.2, halfWidth: 0.1 },
};

const CLASS_INTERVAL_OPTIONS: Record<VarId, number[]> = {
  T: [0.5, 1, 2],
  S: [0.1, 0.2, 0.5],
};

const CLASS_HALF_WIDTH_OPTIONS: Record<VarId, number[]> = {
  T: [0.2, 0.3, 0.5],
  S: [0.05, 0.1, 0.2],
};

const SEA_ICE_THRESHOLD = 0.3;
const SURFACE_FIELD_HEIGHT_M = 18;
const SEA_ICE_HEIGHT_M = 65;
const SEA_ICE_OPACITY = 0.55;
const MOBILE_PANEL_BREAKPOINT_PX = 820;
const WIND_FEATURE_AVAILABLE = false;

function panelOpenStorageKey(isMobile: boolean) {
  return isMobile ? "gs_panel_open_mobile" : "gs_panel_open_desktop";
}

function makeTicks(min: number, max: number, tickCount: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  if (tickCount <= 1 || min === max) return undefined;
  const out: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    out.push(min + (i * (max - min)) / (tickCount - 1));
  }
  return out;
}

function computeMinMax(values: number[][], opts?: { ignoreExactZero?: boolean }) {
  const ignoreExactZero = Boolean(opts?.ignoreExactZero);
  let min = Infinity;
  let max = -Infinity;
  for (const row of values) {
    for (const v of row) {
      if (!Number.isFinite(v)) continue;
      if (ignoreExactZero && v === 0) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

function parseFiniteNumberInput(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampClassDensity(value: number) {
  if (!Number.isFinite(value)) return CLASS_DENSITY_DEFAULT;
  return clamp(value, CLASS_DENSITY_MIN, CLASS_DENSITY_MAX);
}

function sampleIndices(length: number, targetCount: number) {
  if (!Number.isFinite(length) || length <= 0) return [];
  if (!Number.isFinite(targetCount) || targetCount <= 0 || targetCount >= length) {
    return Array.from({ length }, (_, i) => i);
  }
  const n = Math.max(2, Math.min(length, Math.round(targetCount)));
  if (n >= length) return Array.from({ length }, (_, i) => i);

  const out: number[] = [];
  const step = (length - 1) / (n - 1);
  let prev = -1;
  for (let k = 0; k < n; k++) {
    const idx = Math.round(k * step);
    if (idx !== prev) {
      out.push(idx);
      prev = idx;
    }
  }
  if (out[0] !== 0) out.unshift(0);
  if (out[out.length - 1] !== length - 1) out.push(length - 1);
  return out;
}

function downsampleRowsCols(values: number[][], rowIndices: number[], colIndices: number[]) {
  return rowIndices.map((j) => {
    const src = values[j] ?? [];
    return colIndices.map((i) => Number(src[i]));
  });
}

function downsampleHorizontalGrid(
  values: number[][],
  lon: number[],
  lat: number[],
  maxLon: number,
  maxLat: number
): HorizontalGrid {
  if (!values.length || !values[0]?.length || !lon.length || !lat.length) return { values, lon, lat };
  if (lon.length <= maxLon && lat.length <= maxLat) return { values, lon, lat };
  const lonIdx = sampleIndices(lon.length, maxLon);
  const latIdx = sampleIndices(lat.length, maxLat);
  return {
    lon: lonIdx.map((i) => lon[i]),
    lat: latIdx.map((j) => lat[j]),
    values: downsampleRowsCols(values, latIdx, lonIdx),
  };
}

function downsampleTransectGrid(
  values: number[][],
  lon: number[],
  lat: number[],
  z: number[],
  distanceKm: number[],
  maxLon: number,
  maxDepth: number
): TransectGrid {
  if (!values.length || !values[0]?.length || !lon.length || !lat.length || !z.length) {
    return { values, lon, lat, z, distanceKm };
  }
  if (lon.length <= maxLon && z.length <= maxDepth) return { values, lon, lat, z, distanceKm };
  const lonIdx = sampleIndices(lon.length, maxLon);
  const zIdx = sampleIndices(z.length, maxDepth);
  return {
    lon: lonIdx.map((i) => lon[i]),
    lat: lonIdx.map((i) => lat[i]),
    z: zIdx.map((j) => z[j]),
    distanceKm: lonIdx.map((i) => distanceKm[i]),
    values: downsampleRowsCols(values, zIdx, lonIdx),
  };
}

function haversineKm(a: LonLatPoint, b: LonLatPoint) {
  const toRad = Math.PI / 180;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function cumulativeDistanceKm(lon: number[], lat: number[]) {
  const out = new Array<number>(lon.length);
  let sum = 0;
  for (let i = 0; i < lon.length; i++) {
    if (i === 0) {
      out[i] = 0;
      continue;
    }
    sum += haversineKm({ lon: lon[i - 1], lat: lat[i - 1] }, { lon: lon[i], lat: lat[i] });
    out[i] = sum;
  }
  return out;
}

function buildZonalTransectPath(lon: number[], lat: number): TransectPathSpec {
  const latValues = lon.map(() => lat);
  const distanceKm = cumulativeDistanceKm(lon, latValues);
  return {
    lon: lon.slice(),
    lat: latValues,
    distanceKm,
    totalDistanceKm: distanceKm[distanceKm.length - 1] ?? 0,
  };
}

function buildStraightTransectPath(
  start: LonLatPoint,
  end: LonLatPoint,
  sampleCount: number
): TransectPathSpec {
  const n = Math.max(2, Math.min(260, Math.round(sampleCount)));
  const lon = new Array<number>(n);
  const lat = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 0 : i / (n - 1);
    lon[i] = start.lon + (end.lon - start.lon) * t;
    lat[i] = start.lat + (end.lat - start.lat) * t;
  }
  const distanceKm = cumulativeDistanceKm(lon, lat);
  return {
    lon,
    lat,
    distanceKm,
    totalDistanceKm: distanceKm[distanceKm.length - 1] ?? 0,
  };
}

function bracketIndex(values: number[], target: number) {
  const n = values.length;
  if (n <= 1) return { i0: 0, i1: 0, t: 0 };
  const asc = values[n - 1] >= values[0];
  if (asc) {
    if (target <= values[0]) return { i0: 0, i1: 0, t: 0 };
    if (target >= values[n - 1]) return { i0: n - 1, i1: n - 1, t: 0 };
    for (let i = 1; i < n; i++) {
      if (target <= values[i]) {
        const a = Number(values[i - 1]);
        const b = Number(values[i]);
        const span = b - a;
        return { i0: i - 1, i1: i, t: Math.abs(span) <= 1e-9 ? 0 : (target - a) / span };
      }
    }
  } else {
    if (target >= values[0]) return { i0: 0, i1: 0, t: 0 };
    if (target <= values[n - 1]) return { i0: n - 1, i1: n - 1, t: 0 };
    for (let i = 1; i < n; i++) {
      if (target >= values[i]) {
        const a = Number(values[i - 1]);
        const b = Number(values[i]);
        const span = b - a;
        return { i0: i - 1, i1: i, t: Math.abs(span) <= 1e-9 ? 0 : (target - a) / span };
      }
    }
  }
  return { i0: n - 1, i1: n - 1, t: 0 };
}

function sample3DFieldAlongTransect(opts: {
  data: Float32Array;
  nz: number;
  ny: number;
  nx: number;
  lonGrid: number[];
  latGrid: number[];
  path: TransectPathSpec;
}) {
  const { data, nz, ny, nx, lonGrid, latGrid, path } = opts;
  const lonBrackets = path.lon.map((x) => bracketIndex(lonGrid, Number(x)));
  const latBrackets = path.lat.map((y) => bracketIndex(latGrid, Number(y)));
  const out: number[][] = new Array(nz);
  for (let k = 0; k < nz; k++) {
    const row = new Array<number>(path.lon.length);
    const kOffset = k * ny * nx;
    for (let i = 0; i < path.lon.length; i++) {
      const xb = lonBrackets[i];
      const yb = latBrackets[i];
      const v00 = Number(data[kOffset + yb.i0 * nx + xb.i0]);
      const v10 = Number(data[kOffset + yb.i0 * nx + xb.i1]);
      const v01 = Number(data[kOffset + yb.i1 * nx + xb.i0]);
      const v11 = Number(data[kOffset + yb.i1 * nx + xb.i1]);
      if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) {
        row[i] = Number.NaN;
        continue;
      }
      const tx = Math.max(0, Math.min(1, xb.t));
      const ty = Math.max(0, Math.min(1, yb.t));
      const a = v00 * (1 - tx) + v10 * tx;
      const b = v01 * (1 - tx) + v11 * tx;
      row[i] = a * (1 - ty) + b * ty;
    }
    out[k] = row;
  }
  return out;
}

function downsampleVectorGrid(
  u: number[][],
  v: number[][],
  lon: number[],
  lat: number[],
  maxLon: number,
  maxLat: number
): VectorGrid {
  if (!u.length || !u[0]?.length || !v.length || !v[0]?.length || !lon.length || !lat.length) {
    return { u, v, lon, lat };
  }
  if (lon.length <= maxLon && lat.length <= maxLat) return { u, v, lon, lat };
  const lonIdx = sampleIndices(lon.length, maxLon);
  const latIdx = sampleIndices(lat.length, maxLat);
  return {
    lon: lonIdx.map((i) => lon[i]),
    lat: latIdx.map((j) => lat[j]),
    u: latIdx.map((j) => {
      const row = u[j] ?? [];
      return lonIdx.map((i) => Number(row[i]));
    }),
    v: latIdx.map((j) => {
      const row = v[j] ?? [];
      return lonIdx.map((i) => Number(row[i]));
    }),
  };
}

function detectZeroHaloBoundaries(
  data: Float32Array,
  nz: number,
  ny: number,
  nx: number
): { maskedRows: Set<number>; maskedCols: Set<number> } {
  const maskedRows = new Set<number>();
  const maskedCols = new Set<number>();
  if (!Number.isFinite(nz) || !Number.isFinite(ny) || !Number.isFinite(nx)) {
    return { maskedRows, maskedCols };
  }
  if (nz <= 0 || ny <= 0 || nx <= 0) return { maskedRows, maskedCols };
  const depthChecks = Math.min(nz, 2);
  const sparseHaloZeroFraction = 0.98;
  const sparseHaloMaxNonZero = depthChecks * 4;

  const summarizeRow = (row: number) => {
    let finite = 0;
    let zero = 0;
    let nonZero = 0;
    for (let k = 0; k < depthChecks; k++) {
      const base = k * ny * nx + row * nx;
      for (let i = 0; i < nx; i++) {
        const value = Number(data[base + i]);
        if (!Number.isFinite(value)) continue;
        finite += 1;
        if (value === 0) zero += 1;
        else nonZero += 1;
      }
    }
    return { finite, zero, nonZero };
  };

  const summarizeCol = (col: number) => {
    let finite = 0;
    let zero = 0;
    let nonZero = 0;
    for (let k = 0; k < depthChecks; k++) {
      const base = k * ny * nx;
      for (let j = 0; j < ny; j++) {
        const value = Number(data[base + j * nx + col]);
        if (!Number.isFinite(value)) continue;
        finite += 1;
        if (value === 0) zero += 1;
        else nonZero += 1;
      }
    }
    return { finite, zero, nonZero };
  };

  const countsLookLikeZeroHalo = (counts: { finite: number; zero: number; nonZero: number }) => {
    if (counts.finite <= 0 || counts.zero <= 0) return false;
    if (counts.nonZero === 0) return true;
    return counts.zero / counts.finite >= sparseHaloZeroFraction && counts.nonZero <= sparseHaloMaxNonZero;
  };

  for (let row = 0; row < ny; row++) {
    if (!countsLookLikeZeroHalo(summarizeRow(row))) break;
    maskedRows.add(row);
  }
  for (let row = ny - 1; row >= 0; row--) {
    if (!countsLookLikeZeroHalo(summarizeRow(row))) break;
    maskedRows.add(row);
  }
  for (let col = 0; col < nx; col++) {
    if (!countsLookLikeZeroHalo(summarizeCol(col))) break;
    maskedCols.add(col);
  }
  for (let col = nx - 1; col >= 0; col--) {
    if (!countsLookLikeZeroHalo(summarizeCol(col))) break;
    maskedCols.add(col);
  }

  return { maskedRows, maskedCols };
}

function classCenters(cmin: number, cmax: number, step: number) {
  if (!Number.isFinite(cmin) || !Number.isFinite(cmax) || !Number.isFinite(step) || step <= 0) return [];
  const min = Math.min(cmin, cmax);
  const max = Math.max(cmin, cmax);
  const out: number[] = [];
  for (let value = min; value <= max + step * 1e-6; value += step) {
    out.push(Number(value.toFixed(6)));
    if (out.length >= 240) break;
  }
  if (out.length === 0) return [];
  const last = out[out.length - 1];
  if (last < max - step * 0.25 && out.length < 240) out.push(Number(max.toFixed(6)));
  return out;
}

function formatClassLabel(varId: VarId, value: number, interval: number, withUnit = true) {
  const digits = varId === "T" ? (interval >= 1 ? 0 : 1) : interval >= 0.2 ? 1 : 2;
  const text = value.toFixed(digits);
  if (!withUnit) return text;
  return varId === "T" ? `${text}°C` : `${text} g/kg`;
}

function classColorAt(value: number, cmin: number, cmax: number, palette: RGB[]) {
  if (!Number.isFinite(value) || !Number.isFinite(cmin) || !Number.isFinite(cmax) || cmax <= cmin) {
    const safePalette = palette.length ? palette : FALLBACK_FIELD_PALETTE;
    const mid = safePalette[Math.floor(safePalette.length / 2)];
    return `rgb(${mid.r},${mid.g},${mid.b})`;
  }
  const safePalette = palette.length ? palette : FALLBACK_FIELD_PALETTE;
  const t = clamp((value - cmin) / (cmax - cmin), 0, 1);
  const idx = Math.max(0, Math.min(safePalette.length - 1, Math.round(t * (safePalette.length - 1))));
  const c = safePalette[idx];
  return `rgb(${c.r},${c.g},${c.b})`;
}

function makeClassDiscreteColorscale(
  classValues: number[],
  cmin: number,
  cmax: number,
  palette: RGB[]
): Array<[number, string]> {
  const safePalette = palette.length ? palette : FALLBACK_FIELD_PALETTE;
  const fallbackScale = safePalette.length
    ? paletteToColorscale(safePalette)
    : FALLBACK_FIELD_CONTINUOUS;
  if (!Number.isFinite(cmin) || !Number.isFinite(cmax) || cmax <= cmin) return fallbackScale;
  const values = Array.from(
    new Set(classValues.filter((v) => Number.isFinite(v)).map((v) => Number(v.toFixed(6))))
  ).sort((a, b) => a - b);
  if (!values.length) return fallbackScale;
  if (values.length === 1) {
    const color = classColorAt(values[0], cmin, cmax, safePalette);
    return [
      [0, color],
      [1, color],
    ];
  }
  const boundaries: number[] = [cmin];
  for (let i = 0; i < values.length - 1; i++) {
    boundaries.push((values[i] + values[i + 1]) / 2);
  }
  boundaries.push(cmax);
  const out: Array<[number, string]> = [];
  for (let i = 0; i < values.length; i++) {
    const color = classColorAt(values[i], cmin, cmax, safePalette);
    const t0 = clamp((boundaries[i] - cmin) / (cmax - cmin), 0, 1);
    const t1 = clamp((boundaries[i + 1] - cmin) / (cmax - cmin), 0, 1);
    out.push([t0, color], [t1, color]);
  }
  out[0][0] = 0;
  out[out.length - 1][0] = 1;
  return out;
}

function pickClassTicks(values: number[], maxTicks: number) {
  if (values.length <= maxTicks) return values;
  const idx = sampleIndices(values.length, maxTicks);
  return idx.map((i) => values[i]);
}

function makeDiscreteColorscale(levels: number, palette: RGB[]) {
  const safePalette = palette.length ? palette : FALLBACK_FIELD_PALETTE;
  const n = Math.max(2, Math.min(levels, safePalette.length));
  const toCss = (c: { r: number; g: number; b: number }) => `rgb(${c.r},${c.g},${c.b})`;
  const sampled = Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    const idx = Math.round(t * (safePalette.length - 1));
    return safePalette[idx];
  });
  const out: Array<[number, string]> = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const color = toCss(sampled[i]);
    out.push([t0, color], [t1, color]);
  }
  out[out.length - 1][0] = 1;
  return out;
}

function ToggleSwitch(props: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  const { checked, onCheckedChange, disabled, title } = props;
  return (
    <button
      type="button"
      className={`toggle ${checked ? "toggleOn" : ""}`}
      onClick={() => {
        if (disabled) return;
        onCheckedChange(!checked);
      }}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      title={title}
    >
      <span className="toggleKnob" />
    </button>
  );
}

export default function App() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [cameraResetNonce, setCameraResetNonce] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280
  );
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 900
  );
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      if (typeof window !== "undefined") {
        const isMobile = window.innerWidth <= MOBILE_PANEL_BREAKPOINT_PX;
        const saved =
          window.localStorage.getItem(panelOpenStorageKey(isMobile)) ??
          window.localStorage.getItem("gs_panel_open");
        if (saved === "1") return true;
        if (saved === "0") return false;
        return !isMobile;
      }
    } catch {
      // ignore
    }
    return true;
  });
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  const [themeMode, setThemeMode] = useState<"night" | "day">(() => {
    try {
      const saved = window.localStorage.getItem("gs_theme_mode");
      if (saved === "day" || saved === "night") return saved;
    } catch {
      // ignore
    }
    return "night";
  });

  useEffect(() => {
    try {
      const isMobile = viewportWidth <= MOBILE_PANEL_BREAKPOINT_PX;
      window.localStorage.setItem(panelOpenStorageKey(isMobile), panelOpen ? "1" : "0");
      window.localStorage.setItem("gs_panel_open", panelOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [panelOpen, viewportWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    try {
      document.body.setAttribute("data-theme", themeMode);
      window.localStorage.setItem("gs_theme_mode", themeMode);
    } catch {
      // ignore
    }
  }, [themeMode]);

  const [viewMode, setViewMode] = useState<ViewMode>("horizontal");
  const [viewModeHover, setViewModeHover] = useState<Exclude<ViewMode, "eddies"> | null>(null);
  const [varId, setVarId] = useState<VarId>("T");
  const projectOn3d = true;
  const [overlayOpacity, setOverlayOpacity] = useState(0.9);
  const [showColorbar, setShowColorbar] = useState(true);
  const [showFieldContours, setShowFieldContours] = useState(false);
  const [showBathy, setShowBathy] = useState(true);
  const [showBathyContours, setShowBathyContours] = useState(false);
  const [depthRatio, setDepthRatio] = useState(0.35);
  const [depthWarpMode, setDepthWarpMode] = useState<"linear" | "upper">("upper");
  const [depthFocusM, setDepthFocusM] = useState(2500);
  const [deepRatio, setDeepRatio] = useState(0.25);
  const [colorSettings, setColorSettings] = useState<Record<VarId, VarColorSettings>>(
    DEFAULT_COLOR_SETTINGS
  );
  const [drawAutoColorRangeByVar, setDrawAutoColorRangeByVar] = useState<Record<VarId, boolean>>({
    T: true,
    S: true,
  });
  const [fieldColormapByVar, setFieldColormapByVar] = useState<Record<VarId, FieldColormapId>>(
    DEFAULT_FIELD_COLORMAP
  );
  const [bathyColormap, setBathyColormap] = useState<BathyColormapId>(DEFAULT_BATHY_COLORMAP);
  const [colorInputByVar, setColorInputByVar] = useState<Record<VarId, ClassInputSettings>>({
    T: {
      min: String(DEFAULT_COLOR_SETTINGS.T.cmin),
      max: String(DEFAULT_COLOR_SETTINGS.T.cmax),
    },
    S: {
      min: String(DEFAULT_COLOR_SETTINGS.S.cmin),
      max: String(DEFAULT_COLOR_SETTINGS.S.cmax),
    },
  });
  const [classSettingsByVar, setClassSettingsByVar] = useState<Record<VarId, ClassSettings>>(
    DEFAULT_CLASS_SETTINGS
  );
  const [classDensity, setClassDensity] = useState(() => {
    try {
      if (typeof window !== "undefined") {
        const raw = window.localStorage.getItem(CLASS_DENSITY_STORAGE_KEY);
        if (raw != null) {
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) return clampClassDensity(parsed);
        }
      }
    } catch {
      // ignore
    }
    return CLASS_DENSITY_DEFAULT;
  });
  const [classInputByVar, setClassInputByVar] = useState<Record<VarId, ClassInputSettings>>({
    T: {
      min: String(DEFAULT_CLASS_SETTINGS.T.min),
      max: String(DEFAULT_CLASS_SETTINGS.T.max),
    },
    S: {
      min: String(DEFAULT_CLASS_SETTINGS.S.min),
      max: String(DEFAULT_CLASS_SETTINGS.S.max),
    },
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(CLASS_DENSITY_STORAGE_KEY, String(clampClassDensity(classDensity)));
    } catch {
      // ignore
    }
  }, [classDensity]);
  const [eddyThresholdByVar, setEddyThresholdByVar] = useState<Record<VarId, number>>({
    T: EDDY_THRESHOLD_DEFAULT.T,
    S: EDDY_THRESHOLD_DEFAULT.S,
  });
  const [eddyThresholdInputByVar, setEddyThresholdInputByVar] = useState<Record<VarId, string>>({
    T: String(EDDY_THRESHOLD_DEFAULT.T),
    S: String(EDDY_THRESHOLD_DEFAULT.S),
  });
  const [eddyTrackLength, setEddyTrackLength] = useState(EDDY_TRACK_HISTORY_DEFAULT);
  const [eddyMinCells, setEddyMinCells] = useState(EDDY_MIN_CELLS_DEFAULT);
  const [showSeaIce, setShowSeaIce] = useState(true);
  const [showGsrMask, setShowGsrMask] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return false;
      return window.localStorage.getItem(GSR_MASK_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [showGreenlandSeaMask, setShowGreenlandSeaMask] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return false;
      return window.localStorage.getItem(GREENLAND_SEA_MASK_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [showIcelandSeaMask, setShowIcelandSeaMask] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return false;
      return window.localStorage.getItem(ICELAND_SEA_MASK_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [showNorwegianSeaMask, setShowNorwegianSeaMask] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return false;
      return window.localStorage.getItem(NORWEGIAN_SEA_MASK_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [showWind, setShowWind] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(GSR_MASK_STORAGE_KEY, showGsrMask ? "1" : "0");
    } catch {
      // ignore
    }
  }, [showGsrMask]);
  useEffect(() => {
    try {
      window.localStorage.setItem(GREENLAND_SEA_MASK_STORAGE_KEY, showGreenlandSeaMask ? "1" : "0");
    } catch {
      // ignore
    }
  }, [showGreenlandSeaMask]);
  useEffect(() => {
    try {
      window.localStorage.setItem(ICELAND_SEA_MASK_STORAGE_KEY, showIcelandSeaMask ? "1" : "0");
    } catch {
      // ignore
    }
  }, [showIcelandSeaMask]);
  useEffect(() => {
    try {
      window.localStorage.setItem(NORWEGIAN_SEA_MASK_STORAGE_KEY, showNorwegianSeaMask ? "1" : "0");
    } catch {
      // ignore
    }
  }, [showNorwegianSeaMask]);

  const [timeIdx, setTimeIdx] = useState(0);
  const [depthIdx, setDepthIdx] = useState(0);
  const [latTarget, setLatTarget] = useState(75);
  const [latTargetInput, setLatTargetInput] = useState("75");
  const [drawTransectArmed, setDrawTransectArmed] = useState(false);
  const [drawTransectPoints, setDrawTransectPoints] = useState<LonLatPoint[]>([]);
  const [drawTransectHoverPoint, setDrawTransectHoverPoint] = useState<LonLatPoint | null>(null);
  const [drawCameraFocusNonce, setDrawCameraFocusNonce] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(1);

  const [metaStatus, setMetaStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [metaError, setMetaError] = useState<string | null>(null);
  const [meta, setMeta] = useState<GsZarrMeta | null>(null);

  const [sliceStatus, setSliceStatus] = useState<"off" | "loading" | "ready" | "failed">(
    "off"
  );
  const [sliceError, setSliceError] = useState<string | null>(null);
  const [classStatus, setClassStatus] = useState<"off" | "loading" | "ready" | "failed">("off");
  const [classError, setClassError] = useState<string | null>(null);
  const [eddyStatus, setEddyStatus] = useState<"off" | "loading" | "ready" | "failed">("off");
  const [eddyError, setEddyError] = useState<string | null>(null);

  const [seaIceStatus, setSeaIceStatus] = useState<"off" | "loading" | "ready" | "failed">(
    "off"
  );
  const [seaIceError, setSeaIceError] = useState<string | null>(null);
  const [windStatus, setWindStatus] = useState<"off" | "loading" | "ready" | "failed">("off");
  const [windError, setWindError] = useState<string | null>(null);

  const [horizontalValues, setHorizontalValues] = useState<number[][] | null>(null);
  const [transectValues, setTransectValues] = useState<number[][] | null>(null);
  const [transectLatActual, setTransectLatActual] = useState<number | null>(null);
  const [classTraces, setClassTraces] = useState<ClassTrace[] | null>(null);
  const [eddyDetection, setEddyDetection] = useState<EddyDetectionResult | null>(null);
  const [eddyVolume, setEddyVolume] = useState<EddyVolumeCluster[] | null>(null);
  const [seaIceValues, setSeaIceValues] = useState<number[][] | null>(null);
  const [windStress, setWindStress] = useState<{ u: number[][]; v: number[][] } | null>(null);

  const [bathyInfo, setBathyInfo] = useState<{
    plotly: "loading" | "ready" | "failed";
    bathy: "loading" | "file" | "synthetic";
  }>({ plotly: "loading", bathy: "loading" });

  const handleStatusChange = useCallback(
    (s: { plotly: "loading" | "ready" | "failed"; bathy: "loading" | "file" | "synthetic" }) =>
      setBathyInfo({ plotly: s.plotly, bathy: s.bathy }),
    []
  );

  const range = useMemo(() => defaultRange(varId), [varId]);
  const settings = colorSettings[varId];
  const classSettings = classSettingsByVar[varId];
  const classInputs = classInputByVar[varId];
  const colorInputs = colorInputByVar[varId];
  const classMin = Math.min(classSettings.min, classSettings.max);
  const classMax = Math.max(classSettings.min, classSettings.max);
  const classInterval = classSettings.interval;
  const classHalfWidth = classSettings.halfWidth;
  const classHalfWidthEffective = Math.max(0.05, classHalfWidth, classInterval * 0.5);
  const eddyThreshold = Math.max(0.001, Number(eddyThresholdByVar[varId] ?? EDDY_THRESHOLD_DEFAULT[varId]));
  const eddyTrackHistory = Math.max(1, Math.min(EDDY_TRACK_HISTORY_MAX, Math.round(eddyTrackLength)));
  const eddyMinCellCount = Math.max(6, Math.round(eddyMinCells));
  const fieldPalette = useMemo(() => paletteForColormapId(fieldColormapByVar[varId]), [fieldColormapByVar, varId]);
  const fieldContinuousColorscale = useMemo(() => paletteToColorscale(fieldPalette), [fieldPalette]);
  const bathyPalette = useMemo(() => paletteForColormapId(bathyColormap), [bathyColormap]);
  const colorscale = useMemo(() => {
    return settings.mode === "discrete"
      ? makeDiscreteColorscale(settings.levels, fieldPalette)
      : fieldContinuousColorscale;
  }, [fieldContinuousColorscale, fieldPalette, settings.levels, settings.mode]);
  const colorbarTicks = useMemo(
    () => (settings.tickCount > 0 ? makeTicks(settings.cmin, settings.cmax, settings.tickCount) : undefined),
    [settings.cmax, settings.cmin, settings.tickCount]
  );
  const isMobileViewport = viewportWidth <= MOBILE_PANEL_BREAKPOINT_PX;
  const isMobilePortraitViewport = isMobileViewport && viewportHeight > viewportWidth;
  const showColorbarActive = showColorbar && !(isMobilePortraitViewport && !panelOpen);
  const hasSeaIceColorbar = projectOn3d && showSeaIce && showColorbarActive;
  const mainColorbarLayout = useMemo(
    () =>
      hasSeaIceColorbar
        ? isMobileViewport
          ? { x: 0.985, y: 0.68, len: 0.46 }
          : { x: 1.03, y: 0.69, len: 0.60 }
        : isMobileViewport
          ? { x: 0.985, y: 0.50, len: 0.66 }
          : { x: 1.03, y: 0.50, len: 0.84 },
    [hasSeaIceColorbar, isMobileViewport]
  );
  const seaIceColorbarLayout = useMemo(
    () =>
      showColorbarActive
        ? isMobileViewport
          ? { x: 0.985, y: 0.17, len: 0.18 }
          : { x: 1.03, y: 0.17, len: 0.26 }
        : isMobileViewport
          ? { x: 0.985, y: 0.50, len: 0.66 }
          : { x: 1.03, y: 0.50, len: 0.84 },
    [isMobileViewport, showColorbarActive]
  );

  const timeList = meta?.timeIso ?? [];
  const zList = meta?.z ?? [];
  const lonMin = meta?.lon?.length ? Math.min(...meta.lon) : -30;
  const lonMax = meta?.lon?.length ? Math.max(...meta.lon) : 23;
  const latMin = meta?.lat?.length ? Math.min(...meta.lat) : 57.670002;
  const latMax = meta?.lat?.length ? Math.max(...meta.lat) : 81.49752;
  const safeTimeIdx = Math.max(0, Math.min(timeIdx, Math.max(0, timeList.length - 1)));
  const safeDepthIdx = Math.max(0, Math.min(depthIdx, Math.max(0, zList.length - 1)));
  const eddyDepthIdx = zList.length ? nearestIndex(zList, EDDY_DETECTION_DEPTH_M) : 0;
  const eddyDetectionDepthLabel = zList.length
    ? `${Math.round(zList[eddyDepthIdx])} m`
    : `${Math.round(EDDY_DETECTION_DEPTH_M)} m`;
  const eddyTrackHistoryMax = Math.max(
    1,
    Math.min(EDDY_TRACK_HISTORY_MAX, timeList.length || EDDY_TRACK_HISTORY_MAX)
  );
  const activeTimeLabel = timeList[safeTimeIdx] ?? "n/a";
  const activeDepthLabel = zList.length ? `${Math.round(zList[safeDepthIdx])} m` : "n/a";

  const availableVars = useMemo(() => {
    const vars = meta?.variables?.filter((v) => v.available).map((v) => v.id) ?? [];
    return vars.length ? (vars as VarId[]) : (["T"] as VarId[]);
  }, [meta]);

  useEffect(() => {
    const nextMin = String(classSettings.min);
    const nextMax = String(classSettings.max);
    setClassInputByVar((prev) => {
      const curr = prev[varId];
      if (curr?.min === nextMin && curr?.max === nextMax) return prev;
      return {
        ...prev,
        [varId]: { min: nextMin, max: nextMax },
      };
    });
  }, [classSettings.max, classSettings.min, varId]);

  useEffect(() => {
    const nextMin = String(settings.cmin);
    const nextMax = String(settings.cmax);
    setColorInputByVar((prev) => {
      const curr = prev[varId];
      if (curr?.min === nextMin && curr?.max === nextMax) return prev;
      return {
        ...prev,
        [varId]: { min: nextMin, max: nextMax },
      };
    });
  }, [settings.cmax, settings.cmin, varId]);

  useEffect(() => {
    const next = String(eddyThreshold);
    setEddyThresholdInputByVar((prev) => {
      const curr = prev[varId];
      if (curr === next) return prev;
      return { ...prev, [varId]: next };
    });
  }, [eddyThreshold, varId]);

  useEffect(() => {
    setLatTargetInput(String(Number(latTarget.toFixed(3))));
  }, [latTarget]);

  const commitClassInput = useCallback(
    (bound: "min" | "max") => {
      const raw = (classInputByVar[varId]?.[bound] ?? "").trim();
      const parsed = parseFiniteNumberInput(raw);
      const fallback = bound === "min" ? classSettings.min : classSettings.max;
      if (parsed != null) {
        setClassSettingsByVar((prev) => ({
          ...prev,
          [varId]: { ...prev[varId], [bound]: parsed },
        }));
        setClassInputByVar((prev) => ({
          ...prev,
          [varId]: {
            ...(prev[varId] ?? { min: "", max: "" }),
            [bound]: String(parsed),
          },
        }));
      } else {
        setClassInputByVar((prev) => ({
          ...prev,
          [varId]: {
            ...(prev[varId] ?? { min: "", max: "" }),
            [bound]: String(fallback),
          },
        }));
      }
    },
    [classInputByVar, classSettings.max, classSettings.min, varId]
  );

  const updateClassInputLive = useCallback(
    (bound: "min" | "max", rawValue: string) => {
      setClassInputByVar((prev) => ({
        ...prev,
        [varId]: { ...(prev[varId] ?? { min: "", max: "" }), [bound]: rawValue },
      }));
      const parsed = parseFiniteNumberInput(rawValue);
      if (parsed == null) return;
      setClassSettingsByVar((prev) => ({
        ...prev,
        [varId]: {
          ...prev[varId],
          [bound]: parsed,
        },
      }));
    },
    [varId]
  );

  const setDrawAutoColorRangeEnabled = useCallback(
    (enabled: boolean) => {
      setDrawAutoColorRangeByVar((prev) =>
        prev[varId] === enabled
          ? prev
          : {
              ...prev,
              [varId]: enabled,
            }
      );
    },
    [varId]
  );

  const commitColorInput = useCallback(
    (bound: "min" | "max") => {
      if (viewMode === "draw") setDrawAutoColorRangeEnabled(false);
      const raw = (colorInputByVar[varId]?.[bound] ?? "").trim();
      const parsed = parseFiniteNumberInput(raw);
      const fallback = bound === "min" ? settings.cmin : settings.cmax;
      const colorKey = bound === "min" ? "cmin" : "cmax";
      if (parsed != null) {
        setColorSettings((prev) => ({
          ...prev,
          [varId]: {
            ...prev[varId],
            [colorKey]: parsed,
          },
        }));
        setColorInputByVar((prev) => ({
          ...prev,
          [varId]: {
            ...(prev[varId] ?? { min: "", max: "" }),
            [bound]: String(parsed),
          },
        }));
      } else {
        setColorInputByVar((prev) => ({
          ...prev,
          [varId]: {
            ...(prev[varId] ?? { min: "", max: "" }),
            [bound]: String(fallback),
          },
        }));
      }
    },
    [colorInputByVar, setDrawAutoColorRangeEnabled, settings.cmax, settings.cmin, varId, viewMode]
  );

  const updateColorInputLive = useCallback(
    (bound: "min" | "max", rawValue: string) => {
      if (viewMode === "draw") setDrawAutoColorRangeEnabled(false);
      setColorInputByVar((prev) => ({
        ...prev,
        [varId]: { ...(prev[varId] ?? { min: "", max: "" }), [bound]: rawValue },
      }));
      const parsed = parseFiniteNumberInput(rawValue);
      if (parsed == null) return;
      const colorKey = bound === "min" ? "cmin" : "cmax";
      setColorSettings((prev) => ({
        ...prev,
        [varId]: {
          ...prev[varId],
          [colorKey]: parsed,
        },
      }));
    },
    [setDrawAutoColorRangeEnabled, varId, viewMode]
  );

  const commitEddyThresholdInput = useCallback(() => {
    const raw = (eddyThresholdInputByVar[varId] ?? "").trim();
    const parsed = parseFiniteNumberInput(raw);
    const fallback = eddyThresholdByVar[varId] ?? EDDY_THRESHOLD_DEFAULT[varId];
    const next =
      parsed != null && parsed > 0
        ? parsed
        : fallback;
    setEddyThresholdByVar((prev) => ({ ...prev, [varId]: next }));
    setEddyThresholdInputByVar((prev) => ({ ...prev, [varId]: String(next) }));
  }, [eddyThresholdByVar, eddyThresholdInputByVar, varId]);

  const updateEddyThresholdInputLive = useCallback(
    (rawValue: string) => {
      setEddyThresholdInputByVar((prev) => ({ ...prev, [varId]: rawValue }));
      const parsed = parseFiniteNumberInput(rawValue);
      if (parsed == null || parsed <= 0) return;
      setEddyThresholdByVar((prev) => ({ ...prev, [varId]: parsed }));
    },
    [varId]
  );

  const commitLatTargetInput = useCallback(() => {
    const raw = latTargetInput.trim();
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      const clamped = clamp(parsed, latMin, latMax);
      setLatTarget(clamped);
      setLatTargetInput(String(Number(clamped.toFixed(3))));
    } else {
      setLatTargetInput(String(Number(latTarget.toFixed(3))));
    }
  }, [latMax, latMin, latTarget, latTargetInput]);

  const spatialMask = useMemo<SpatialMaskState>(
    () => ({
      gsr: showGsrMask,
      greenlandSea: showGreenlandSeaMask,
      icelandSea: showIcelandSeaMask,
      norwegianSea: showNorwegianSeaMask,
    }),
    [showGsrMask, showGreenlandSeaMask, showIcelandSeaMask, showNorwegianSeaMask]
  );
  const allSubdomainMasksEnabled =
    showGsrMask && showGreenlandSeaMask && showIcelandSeaMask && showNorwegianSeaMask;
  const anySubdomainMaskEnabled =
    showGsrMask || showGreenlandSeaMask || showIcelandSeaMask || showNorwegianSeaMask;

  const drawnTransectPath = useMemo<TransectPathSpec | null>(() => {
    if (drawTransectPoints.length < 2) return null;
    return buildStraightTransectPath(
      drawTransectPoints[0],
      drawTransectPoints[1],
      playing ? DRAW_TRANSECT_SAMPLES_PLAYING : DRAW_TRANSECT_SAMPLES_PAUSED
    );
  }, [drawTransectPoints, playing]);

  const activeTransectPath = useMemo<TransectPathSpec | null>(() => {
    if (viewMode === "draw") return drawnTransectPath;
    if (viewMode === "transect" && meta && transectLatActual != null) {
      return buildZonalTransectPath(meta.lon, transectLatActual);
    }
    return null;
  }, [drawnTransectPath, meta, transectLatActual, viewMode]);

  const drawTransectLengthKm = drawnTransectPath?.totalDistanceKm ?? 0;
  const viewModeDescription =
    VIEW_MODE_DESCRIPTIONS[(viewModeHover ?? (viewMode === "eddies" ? "horizontal" : viewMode)) as Exclude<
      ViewMode,
      "eddies"
    >];
  const drawTransectHint =
    !drawTransectArmed && drawTransectPoints.length < 2
      ? 'Draw mode is idle. Click "Redraw line" or clear the line to start a new transect.'
      : drawTransectArmed && drawTransectPoints.length === 0
        ? "Hover the map, then click the transect start point."
      : drawTransectArmed && drawTransectPoints.length === 1
          ? "Move over the map to preview the line, then click the transect end point."
          : drawTransectPoints.length >= 2
            ? `Transect length: ${drawTransectLengthKm.toFixed(0)} km.`
            : "Draw a line to extract an arbitrary transect.";

  useEffect(() => {
    if (viewMode !== "draw") {
      setDrawTransectArmed(false);
      setDrawTransectHoverPoint(null);
      return;
    }
    if (!drawTransectPoints.length) setDrawTransectArmed(true);
  }, [viewMode]);

  useEffect(() => {
    if (drawTransectPoints.length >= 2) {
      setDrawTransectArmed(false);
      setDrawTransectHoverPoint(null);
    }
  }, [drawTransectPoints]);

  const lastDrawCameraFocusKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (drawTransectPoints.length < 2) {
      lastDrawCameraFocusKeyRef.current = null;
      return;
    }
    const key = drawTransectPoints.map((point) => `${point.lon.toFixed(4)},${point.lat.toFixed(4)}`).join("|");
    if (key === lastDrawCameraFocusKeyRef.current) return;
    lastDrawCameraFocusKeyRef.current = key;
    setDrawCameraFocusNonce((value) => value + 1);
  }, [drawTransectPoints]);

  const horizontalValuesMasked = useMemo(() => {
    if (!meta || !horizontalValues) return horizontalValues;
    return applySpatialMaskToHorizontal(horizontalValues, meta.lon, meta.lat, spatialMask);
  }, [horizontalValues, meta, spatialMask]);

  const transectValuesMasked = useMemo(() => {
    if (!transectValues || !activeTransectPath) return transectValues;
    return applySpatialMaskToTransect(transectValues, activeTransectPath.lon, activeTransectPath.lat, spatialMask);
  }, [activeTransectPath, spatialMask, transectValues]);

  const horizontalRender = useMemo<HorizontalGrid | null>(() => {
    if (!meta || !horizontalValuesMasked) return null;
    if (!playing) return { values: horizontalValuesMasked, lon: meta.lon, lat: meta.lat };
    return downsampleHorizontalGrid(
      horizontalValuesMasked,
      meta.lon,
      meta.lat,
      PLAYBACK_SURFACE_MAX,
      PLAYBACK_SURFACE_MAX
    );
  }, [horizontalValuesMasked, meta, playing]);

  const transectRender = useMemo<TransectGrid | null>(() => {
    if (!meta || !transectValuesMasked || !activeTransectPath) return null;
    if (!playing) {
      return {
        values: transectValuesMasked,
        lon: activeTransectPath.lon,
        lat: activeTransectPath.lat,
        z: meta.z,
        distanceKm: activeTransectPath.distanceKm,
      };
    }
    return downsampleTransectGrid(
      transectValuesMasked,
      activeTransectPath.lon,
      activeTransectPath.lat,
      meta.z,
      activeTransectPath.distanceKm,
      PLAYBACK_TRANSECT_LON_MAX,
      PLAYBACK_TRANSECT_DEPTH_MAX
    );
  }, [activeTransectPath, meta, playing, transectValuesMasked]);

  const drawTransectComplete = viewMode === "draw" && transectRender != null;
  const drawTransectAutoRange = useMemo(
    () =>
      drawTransectComplete && transectValuesMasked
        ? computeMinMax(transectValuesMasked, { ignoreExactZero: varId === "S" })
        : null,
    [drawTransectComplete, transectValuesMasked, varId]
  );
  const drawAutoColorRangeActive =
    viewMode === "draw" && Boolean(drawAutoColorRangeByVar[varId] && drawTransectAutoRange);
  const drawDisplayedColorInput = drawAutoColorRangeActive && drawTransectAutoRange
    ? {
        min: String(Number(drawTransectAutoRange.min.toFixed(3))),
        max: String(Number(drawTransectAutoRange.max.toFixed(3))),
      }
    : null;

  const seaIceRender = useMemo<HorizontalGrid | null>(() => {
    if (!meta || !seaIceValues) return null;
    const values = applySpatialMaskToHorizontal(seaIceValues, meta.lon, meta.lat, spatialMask);
    if (!playing) return { values, lon: meta.lon, lat: meta.lat };
    return downsampleHorizontalGrid(
      values,
      meta.lon,
      meta.lat,
      PLAYBACK_SEA_ICE_MAX,
      PLAYBACK_SEA_ICE_MAX
    );
  }, [meta, playing, seaIceValues, spatialMask]);

  const windRender = useMemo<VectorGrid | null>(() => {
    if (!meta || !windStress) return null;
    const masked = applySpatialMaskToVectorGrid(windStress, meta.lon, meta.lat, spatialMask);
    if (!playing) return { ...masked, lon: meta.lon, lat: meta.lat };
    return downsampleVectorGrid(
      masked.u,
      masked.v,
      meta.lon,
      meta.lat,
      PLAYBACK_WIND_MAX,
      PLAYBACK_WIND_MAX
    );
  }, [meta, playing, spatialMask, windStress]);

  useEffect(() => {
    let cancelled = false;
    setMetaStatus("loading");
    setMetaError(null);
    loadGsZarrMeta()
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        setMetaStatus("ready");
        setTimeIdx(0);
        setDepthIdx(0);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error(e);
        setMeta(null);
        setMetaStatus("failed");
        setMetaError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!availableVars.includes(varId)) setVarId(availableVars[0]);
  }, [availableVars, varId]);

  useEffect(() => {
    if (!playing) return;
    if (metaStatus !== "ready" || !timeList.length) return;
    const intervalMs = Math.max(250, Math.round(1000 / Math.max(0.5, fps)));
    const t = window.setInterval(() => {
      // Avoid stepping time while the current frame is still loading.
      if (sliceStatus === "loading") return;
      setTimeIdx((i) => (i + 1) % timeList.length);
    }, intervalMs);
    return () => window.clearInterval(t);
  }, [fps, metaStatus, playing, sliceStatus, timeList.length]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready") return;
    if (!projectOn3d) {
      setSliceStatus("off");
      setSliceError(null);
      setClassStatus("off");
      setClassError(null);
      setEddyStatus("off");
      setEddyError(null);
      setHorizontalValues(null);
      setTransectValues(null);
      setTransectLatActual(null);
      setClassTraces(null);
      setEddyDetection(null);
      setEddyVolume(null);
      return;
    }

    let cancelled = false;
    setSliceStatus("loading");
    setSliceError(null);

    (async () => {
      try {
        if (viewMode === "horizontal") {
          const values = await loadHorizontalSlice({
            storeUrl: meta.storeUrl,
            varId,
            tIndex: safeTimeIdx,
            zIndex: safeDepthIdx,
            nLat: meta.lat.length,
            nLon: meta.lon.length,
          });
          if (cancelled) return;
          setHorizontalValues(values);
          setTransectValues(null);
          setTransectLatActual(null);
          setClassTraces(null);
          setEddyDetection(null);
          setEddyVolume(null);
          setClassStatus("off");
          setClassError(null);
          setEddyStatus("off");
          setEddyError(null);
          setSliceStatus("ready");
        } else if (viewMode === "transect") {
          const yIndex = nearestIndex(meta.lat, latTarget);
          const { values } = await loadTransectSlice({
            storeUrl: meta.storeUrl,
            varId,
            tIndex: safeTimeIdx,
            yIndex,
          });
          if (cancelled) return;
          setTransectValues(values);
          setHorizontalValues(null);
          setTransectLatActual(meta.lat[yIndex] ?? latTarget);
          setClassTraces(null);
          setEddyDetection(null);
          setEddyVolume(null);
          setClassStatus("off");
          setClassError(null);
          setEddyStatus("off");
          setEddyError(null);
          setSliceStatus("ready");
        } else if (viewMode === "draw") {
          const horizontalPromise = loadHorizontalSlice({
            storeUrl: meta.storeUrl,
            varId,
            tIndex: safeTimeIdx,
            zIndex: safeDepthIdx,
            nLat: meta.lat.length,
            nLon: meta.lon.length,
          });

          if (!drawnTransectPath) {
            const values = await horizontalPromise;
            if (cancelled) return;
            setHorizontalValues(values);
            setTransectValues(null);
            setTransectLatActual(null);
            setClassTraces(null);
            setEddyDetection(null);
            setEddyVolume(null);
            setClassStatus("off");
            setClassError(null);
            setEddyStatus("off");
            setEddyError(null);
            setSliceStatus("ready");
          } else {
            const [horizontal, full] = await Promise.all([
              horizontalPromise,
              load3DFieldAtTime({
                storeUrl: meta.storeUrl,
                varId,
                tIndex: safeTimeIdx,
              }),
            ]);
            if (cancelled) return;
            const values = sample3DFieldAlongTransect({
              data: full.data,
              nz: full.nz,
              ny: full.ny,
              nx: full.nx,
              lonGrid: meta.lon,
              latGrid: meta.lat,
              path: drawnTransectPath,
            });
            setHorizontalValues(horizontal);
            setTransectValues(values);
            setTransectLatActual(null);
            setClassTraces(null);
            setEddyDetection(null);
            setEddyVolume(null);
            setClassStatus("off");
            setClassError(null);
            setEddyStatus("off");
            setEddyError(null);
            setSliceStatus("ready");
          }
        } else if (viewMode === "class") {
          setClassStatus("loading");
          setClassError(null);
          setEddyStatus("off");
          setEddyError(null);

          const full = await load3DFieldAtTime({
            storeUrl: meta.storeUrl,
            varId,
            tIndex: safeTimeIdx,
          });
          if (cancelled) return;

          const density = clampClassDensity(classDensity);
          const nxLimit = Math.max(8, Math.round((playing ? CLASS_MAX_XY_PLAYING : CLASS_MAX_XY_PAUSED) * density));
          const nyLimit = Math.max(8, Math.round((playing ? CLASS_MAX_XY_PLAYING : CLASS_MAX_XY_PAUSED) * density));
          const nzLimit = Math.max(4, Math.round((playing ? CLASS_MAX_Z_PLAYING : CLASS_MAX_Z_PAUSED) * density));
          const xIdx = sampleIndices(full.nx, nxLimit);
          const yIdx = sampleIndices(full.ny, nyLimit);
          const zIdx = sampleIndices(full.nz, nzLimit);
          const { maskedRows, maskedCols } = detectZeroHaloBoundaries(
            full.data,
            full.nz,
            full.ny,
            full.nx
          );

          const centers = classCenters(classMin, classMax, classInterval);
          const perClassCap = Math.max(
            80,
            Math.round((playing ? CLASS_POINTS_PER_CLASS_PLAYING : CLASS_POINTS_PER_CLASS_PAUSED) * density)
          );

          if (!centers.length) {
            setClassTraces([]);
            setHorizontalValues(null);
            setTransectValues(null);
            setTransectLatActual(null);
            setEddyDetection(null);
            setEddyVolume(null);
            setClassStatus("ready");
            setSliceStatus("ready");
            return;
          }

          const traces = centers.map((center, index) => ({
            value: center,
            label: formatClassLabel(varId, center, classInterval, true),
            x: [] as number[],
            y: [] as number[],
            z: [] as number[],
            seen: 0,
            rand: ((safeTimeIdx + 1) * 2654435761 + (index + 1) * 2246822519) >>> 0,
          }));

          const step = classInterval;
          const half = classHalfWidthEffective;
          const minCenter = classMin;
          const maxCenter = classMax;

          for (let zk = 0; zk < zIdx.length; zk++) {
            const zIndex = zIdx[zk];
            const depth = Number(meta.z[zIndex]);
            if (!Number.isFinite(depth)) continue;
            for (let yk = 0; yk < yIdx.length; yk++) {
              const yIndex = yIdx[yk];
              if (maskedRows.has(yIndex)) continue;
              const lat = Number(meta.lat[yIndex]);
              if (!Number.isFinite(lat)) continue;
              for (let xk = 0; xk < xIdx.length; xk++) {
                const xIndex = xIdx[xk];
                if (maskedCols.has(xIndex)) continue;
                const lon = Number(meta.lon[xIndex]);
                if (!Number.isFinite(lon)) continue;
                if (!pointPassesSpatialMask(lon, lat, spatialMask)) continue;
                const offset = zIndex * full.ny * full.nx + yIndex * full.nx + xIndex;
                const value = Number(full.data[offset]);
                if (!Number.isFinite(value)) continue;
                if (value < minCenter - half || value > maxCenter + half) continue;

                const bucket = Math.round((value - minCenter) / step);
                if (bucket < 0 || bucket >= traces.length) continue;
                const center = traces[bucket].value;
                if (Math.abs(value - center) > half) continue;

                const bucketTrace = traces[bucket];
                bucketTrace.seen += 1;
                if (bucketTrace.x.length < perClassCap) {
                  bucketTrace.x.push(lon);
                  bucketTrace.y.push(lat);
                  bucketTrace.z.push(depth);
                } else {
                  bucketTrace.rand = (1664525 * bucketTrace.rand + 1013904223) >>> 0;
                  const replace = bucketTrace.rand % bucketTrace.seen;
                  if (replace < perClassCap) {
                    bucketTrace.x[replace] = lon;
                    bucketTrace.y[replace] = lat;
                    bucketTrace.z[replace] = depth;
                  }
                }
              }
            }
          }

          const filtered: ClassTrace[] = traces
            .filter((trace) => trace.x.length > 0)
            .map((trace) => ({
              label: trace.label,
              value: trace.value,
              x: trace.x,
              y: trace.y,
              z: trace.z,
            }));

          if (cancelled) return;
          setClassTraces(filtered);
          setHorizontalValues(null);
          setTransectValues(null);
          setTransectLatActual(null);
          setEddyDetection(null);
          setEddyVolume(null);
          setClassStatus("ready");
          setSliceStatus("ready");
        } else {
          setClassStatus("off");
          setClassError(null);
          setEddyStatus("loading");
          setEddyError(null);

          const historyCount = Math.max(1, Math.min(timeList.length, eddyTrackHistory));
          const frameIndices = Array.from({ length: historyCount }, (_, offset) =>
            (safeTimeIdx - (historyCount - 1 - offset) + timeList.length) % timeList.length
          );
          const frameValues = await Promise.all(
            frameIndices.map((tIndex) =>
              loadHorizontalSlice({
                storeUrl: meta.storeUrl,
                varId,
                tIndex,
                zIndex: eddyDepthIdx,
                nLat: meta.lat.length,
                nLon: meta.lon.length,
              })
            )
          );
          if (cancelled) return;
          const eddyFrameValues = frameValues.map((grid) =>
            applySpatialMaskToHorizontal(grid, meta.lon, meta.lat, spatialMask)
          );

          const detection = detectAndTrackEddies(
            frameIndices.map((tIndex, index) => ({ timeIndex: tIndex, values: eddyFrameValues[index] })),
            meta.lon,
            meta.lat,
            {
              zeroAsMissing: varId === "S",
              threshold: eddyThreshold,
              thresholdFloor: EDDY_THRESHOLD_DEFAULT[varId],
              minCells: eddyMinCellCount,
              sampleCap: playing ? EDDY_POINTS_PER_CLUSTER_PLAYING : EDDY_POINTS_PER_CLUSTER_PAUSED,
              trackHistory: historyCount,
            }
          );
          const largestBoreas = detection.clusters
            .filter(
              (cluster) =>
                inBoreasBasin(cluster.centroidLon, cluster.centroidLat) &&
                pointPassesSpatialMask(cluster.centroidLon, cluster.centroidLat, spatialMask)
            )
            .sort((a, b) => {
              const byCells = b.cellCount - a.cellCount;
              if (byCells !== 0) return byCells;
              return b.radiusKm - a.radiusKm;
            })[0];
          const selectedClusters = largestBoreas ? [largestBoreas] : [];
          const selectedDetection: EddyDetectionResult = {
            ...detection,
            clusters: selectedClusters,
          };

          const full = await load3DFieldAtTime({
            storeUrl: meta.storeUrl,
            varId,
            tIndex: safeTimeIdx,
          });

          if (cancelled) return;
          const volume = buildEddyVolume({
            data: full.data,
            nz: full.nz,
            ny: full.ny,
            nx: full.nx,
            lon: meta.lon,
            lat: meta.lat,
            z: meta.z,
            clusters: selectedClusters,
            zeroAsMissing: varId === "S",
            threshold: eddyThreshold,
            thresholdFloor: EDDY_THRESHOLD_DEFAULT[varId],
            depthSampleCount: playing
              ? EDDY_VOLUME_DEPTH_SAMPLES_PLAYING
              : EDDY_VOLUME_DEPTH_SAMPLES_PAUSED,
            pointCapPerCluster: playing
              ? EDDY_VOLUME_POINTS_PER_CLUSTER_PLAYING
              : EDDY_VOLUME_POINTS_PER_CLUSTER_PAUSED,
          });

          if (cancelled) return;
          setEddyDetection(selectedDetection);
          setHorizontalValues(null);
          setTransectValues(null);
          setTransectLatActual(null);
          setClassTraces(null);
          setEddyVolume(volume);
          setEddyStatus("ready");
          setSliceStatus("ready");
        }
      } catch (e) {
        if (cancelled) return;
        console.error(e);
        setSliceStatus("failed");
        setSliceError(e instanceof Error ? e.message : String(e));
        if (viewMode === "class") {
          setClassStatus("failed");
          setClassError(e instanceof Error ? e.message : String(e));
          setEddyStatus("off");
          setEddyError(null);
        } else if (viewMode === "eddies") {
          setClassStatus("off");
          setClassError(null);
          setEddyStatus("failed");
          setEddyError(e instanceof Error ? e.message : String(e));
        } else {
          setClassStatus("off");
          setClassError(null);
          setEddyStatus("off");
          setEddyError(null);
        }
        setHorizontalValues(null);
        setTransectValues(null);
        setTransectLatActual(null);
        setClassTraces(null);
        setEddyDetection(null);
        setEddyVolume(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    latTarget,
    meta,
    metaStatus,
    projectOn3d,
    spatialMask,
    eddyDepthIdx,
    safeDepthIdx,
    safeTimeIdx,
    classMax,
    classMin,
    classHalfWidth,
    classHalfWidthEffective,
    classInterval,
    classDensity,
    eddyMinCellCount,
    eddyThreshold,
    eddyTrackHistory,
    drawnTransectPath,
    timeList.length,
    varId,
    viewMode,
    playing,
  ]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready" || !projectOn3d || !showSeaIce) {
      setSeaIceStatus("off");
      setSeaIceError(null);
      setSeaIceValues(null);
      return;
    }

    let cancelled = false;
    setSeaIceStatus("loading");
    setSeaIceError(null);
    loadSeaIce2D({ storeUrl: meta.storeUrl, tIndex: safeTimeIdx })
      .then((values) => {
        if (cancelled) return;
        setSeaIceValues(values);
        setSeaIceStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error(e);
        setSeaIceValues(null);
        setSeaIceStatus("failed");
        setSeaIceError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [meta, metaStatus, projectOn3d, safeTimeIdx, showSeaIce]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready" || !projectOn3d || !showWind) {
      setWindStatus("off");
      setWindError(null);
      setWindStress(null);
      return;
    }

    let cancelled = false;
    setWindStatus("loading");
    setWindError(null);
    loadWindStress2D({ storeUrl: meta.storeUrl, tIndex: safeTimeIdx })
      .then((values) => {
        if (cancelled) return;
        setWindStress(values);
        setWindStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error(e);
        setWindStress(null);
        setWindStatus("failed");
        setWindError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [meta, metaStatus, projectOn3d, safeTimeIdx, showWind]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready" || !projectOn3d || !playing) return;
    if (!timeList.length) return;
    const ahead = 10;
    const yIndex = viewMode === "transect" ? nearestIndex(meta.lat, latTarget) : -1;
    const hasDrawTransect = viewMode === "draw" && drawnTransectPath != null;
    const seaIcePrefetch = new Set<number>();
    const windPrefetch = new Set<number>();
    for (let step = 1; step <= ahead; step++) {
      const tIndex = (safeTimeIdx + step) % timeList.length;
      if (viewMode === "horizontal" || viewMode === "eddies" || viewMode === "draw") {
        void loadHorizontalSlice({
          storeUrl: meta.storeUrl,
          varId,
          tIndex,
          zIndex: viewMode === "eddies" ? eddyDepthIdx : safeDepthIdx,
          nLat: meta.lat.length,
          nLon: meta.lon.length,
        }).catch(() => undefined);
        if (viewMode === "eddies" && step <= 3) {
          void load3DFieldAtTime({
            storeUrl: meta.storeUrl,
            varId,
            tIndex,
          }).catch(() => undefined);
        }
        if (hasDrawTransect && step <= 3) {
          void load3DFieldAtTime({
            storeUrl: meta.storeUrl,
            varId,
            tIndex,
          }).catch(() => undefined);
        }
      } else if (viewMode === "transect") {
        void loadTransectSlice({
          storeUrl: meta.storeUrl,
          varId,
          tIndex,
          yIndex,
        }).catch(() => undefined);
      } else {
        if (step <= 3) {
          void load3DFieldAtTime({
            storeUrl: meta.storeUrl,
            varId,
            tIndex,
          }).catch(() => undefined);
        }
      }
      if (showSeaIce) {
        seaIcePrefetch.add(tIndex);
      }
      if (showWind) {
        windPrefetch.add(tIndex);
      }
    }
    seaIcePrefetch.forEach((tIndex) => {
      void loadSeaIce2D({ storeUrl: meta.storeUrl, tIndex }).catch(() => undefined);
    });
    windPrefetch.forEach((tIndex) => {
      void loadWindStress2D({ storeUrl: meta.storeUrl, tIndex }).catch(() => undefined);
    });
  }, [
    latTarget,
    meta,
    metaStatus,
    playing,
    projectOn3d,
    eddyDepthIdx,
    safeDepthIdx,
    safeTimeIdx,
    showSeaIce,
    showWind,
    timeList.length,
    varId,
    viewMode,
    drawnTransectPath,
  ]);

  const selectedSliceZ = useMemo(() => {
    const selectedDepth = Number(meta?.z?.[safeDepthIdx] ?? 0);
    return Number.isFinite(selectedDepth) && Math.abs(selectedDepth) <= 2
      ? SURFACE_FIELD_HEIGHT_M
      : selectedDepth;
  }, [meta, safeDepthIdx]);

  const handleDrawSurfaceHover = useCallback(
    (pick: LonLatPoint | null) => {
      if (viewMode !== "draw" || !drawTransectArmed) {
        setDrawTransectHoverPoint(null);
        return;
      }
      if (!pick) {
        setDrawTransectHoverPoint(null);
        return;
      }
      const lon = clamp(Number(pick.lon), lonMin, lonMax);
      const lat = clamp(Number(pick.lat), latMin, latMax);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        setDrawTransectHoverPoint(null);
        return;
      }
      setDrawTransectHoverPoint({ lon, lat });
    },
    [drawTransectArmed, latMax, latMin, lonMax, lonMin, viewMode]
  );

  const handleDrawSurfacePick = useCallback(
    (pick: LonLatPoint) => {
      if (viewMode !== "draw" || !drawTransectArmed) return;
      const lon = clamp(Number(pick.lon), lonMin, lonMax);
      const lat = clamp(Number(pick.lat), latMin, latMax);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      setDrawTransectPoints((prev) => {
        if (!prev.length) return [{ lon, lat }];
        const start = prev[0];
        if (haversineKm(start, { lon, lat }) < 8) return prev;
        return [start, { lon, lat }];
      });
    },
    [drawTransectArmed, latMax, latMin, lonMax, lonMin, viewMode]
  );

  const drawGuidePath = useMemo(() => {
    if (viewMode !== "draw") return undefined;
    const points: LonLatPoint[] =
      drawTransectArmed && drawTransectPoints.length === 1 && drawTransectHoverPoint
        ? [drawTransectPoints[0], drawTransectHoverPoint]
        : drawTransectPoints.length
          ? drawTransectPoints
          : drawTransectArmed && drawTransectHoverPoint
            ? [drawTransectHoverPoint]
            : [];
    if (!points.length) return undefined;
    return {
      enabled: true,
      lon: points.map((p) => p.lon),
      lat: points.map((p) => p.lat),
      zPlane: selectedSliceZ + 10,
      color: drawTransectArmed ? "rgba(255,212,92,0.96)" : "rgba(99,220,255,0.96)",
      name: "Drawn transect",
    };
  }, [drawTransectArmed, drawTransectHoverPoint, drawTransectPoints, selectedSliceZ, viewMode]);

  const drawCameraFocusPath = useMemo(() => {
    if (viewMode !== "draw" || !drawnTransectPath || drawCameraFocusNonce <= 0) return undefined;
    return {
      nonce: drawCameraFocusNonce,
      lon: drawnTransectPath.lon,
      lat: drawnTransectPath.lat,
    };
  }, [drawCameraFocusNonce, drawnTransectPath, viewMode]);

  const showHorizontalColorbar =
    showColorbarActive &&
    (viewMode === "horizontal" || (viewMode === "draw" && !transectRender));

  const horizontalField = useMemo(() => {
    if (!meta || !projectOn3d || !horizontalRender) return undefined;
    if (viewMode !== "horizontal" && viewMode !== "draw") return undefined;
    if (drawTransectComplete) return undefined;
    return {
      enabled: true,
      values: horizontalRender.values,
      lon: horizontalRender.lon,
      lat: horizontalRender.lat,
      cmin: settings.cmin,
      cmax: settings.cmax,
      colorscale,
      opacity: overlayOpacity,
      mode: "surface" as const,
      zPlane: selectedSliceZ,
      showScale: showHorizontalColorbar,
      colorbarTitle: range.title,
      colorbarTicks,
      colorbarLen: mainColorbarLayout.len,
      colorbarX: mainColorbarLayout.x,
      colorbarY: mainColorbarLayout.y,
      zeroAsMissing: varId === "S",
      maskDryByBathy: true,
    };
  }, [
    colorscale,
    horizontalRender,
    meta,
    overlayOpacity,
    projectOn3d,
    showHorizontalColorbar,
    drawTransectComplete,
    colorbarTicks,
    range.title,
    settings.cmax,
    settings.cmin,
    viewMode,
    mainColorbarLayout.len,
    mainColorbarLayout.x,
    mainColorbarLayout.y,
    selectedSliceZ,
    varId,
  ]);

  const transectField = useMemo(() => {
    if (!meta || !projectOn3d || !transectRender) return undefined;
    if (viewMode !== "transect" && viewMode !== "draw") return undefined;
    const cmin = drawAutoColorRangeActive && drawTransectAutoRange ? drawTransectAutoRange.min : settings.cmin;
    const cmax = drawAutoColorRangeActive && drawTransectAutoRange ? drawTransectAutoRange.max : settings.cmax;
    const transectColorbarTicks =
      drawAutoColorRangeActive && drawTransectAutoRange && settings.tickCount > 0
        ? makeTicks(drawTransectAutoRange.min, drawTransectAutoRange.max, settings.tickCount)
        : colorbarTicks;
    return {
      enabled: true,
      lat: transectRender.lat,
      lon: transectRender.lon,
      distanceKm: transectRender.distanceKm,
      z: transectRender.z,
      values: transectRender.values,
      cmin,
      cmax,
      colorscale,
      opacity: overlayOpacity,
      showScale: showColorbarActive,
      colorbarTitle: range.title,
      colorbarTicks: transectColorbarTicks,
      colorbarLen: mainColorbarLayout.len,
      colorbarX: mainColorbarLayout.x,
      colorbarY: mainColorbarLayout.y,
    };
  }, [
    colorscale,
    colorbarTicks,
    drawAutoColorRangeActive,
    drawTransectAutoRange,
    meta,
    overlayOpacity,
    projectOn3d,
    showColorbarActive,
    range.title,
    settings.cmax,
    settings.cmin,
    settings.tickCount,
    transectRender,
    viewMode,
    mainColorbarLayout.len,
    mainColorbarLayout.x,
    mainColorbarLayout.y,
  ]);

  const seaIcePlane = useMemo(() => {
    if (!meta || !projectOn3d || !showSeaIce || !seaIceRender) return null;
    const masked = seaIceRender.values.map((row) =>
      row.map((v) => {
        const x = Number(v);
        if (!Number.isFinite(x)) return Number.NaN;
        if (x <= SEA_ICE_THRESHOLD) return Number.NaN;
        return Math.max(0, Math.min(1, x));
      })
    );
    const cmin = Math.max(0, Math.min(0.99, SEA_ICE_THRESHOLD));
    return {
      enabled: true,
      values: masked,
      lon: seaIceRender.lon,
      lat: seaIceRender.lat,
      cmin,
      cmax: 1,
      colorscale: paletteToColorscale(ice_256()),
      opacity: SEA_ICE_OPACITY,
      mode: "surface" as const,
      zPlane: SEA_ICE_HEIGHT_M,
      showScale: showColorbarActive,
      colorbarTitle: `Sea ice (${cmin.toFixed(2)}–1)`,
      colorbarTicks: [cmin, 0.5, 0.75, 1].filter((v, i, arr) => arr.indexOf(v) === i),
      colorbarLen: seaIceColorbarLayout.len,
      colorbarX: seaIceColorbarLayout.x,
      colorbarY: seaIceColorbarLayout.y,
    };
  }, [
    meta,
    projectOn3d,
    seaIceRender,
    seaIceColorbarLayout.len,
    seaIceColorbarLayout.x,
    seaIceColorbarLayout.y,
    showSeaIce,
    showColorbarActive,
  ]);

  const horizontalPlanes = useMemo(() => {
    if (!meta || !projectOn3d) return undefined;
    return seaIcePlane ? [seaIcePlane] : undefined;
  }, [
    meta,
    projectOn3d,
    seaIcePlane,
  ]);

  const windLayer = useMemo(() => {
    if (!meta || !projectOn3d || !showWind || !windRender) return undefined;
    return {
      enabled: true,
      lon: windRender.lon,
      lat: windRender.lat,
      u: windRender.u,
      v: windRender.v,
      zPlane: SEA_ICE_HEIGHT_M + 12,
      particleCount: playing ? 180 : 320,
      speed: 2.6,
      color: "rgba(255,255,255,0.90)",
      size: playing ? 1.1 : 1.35,
    };
  }, [meta, projectOn3d, showWind, windRender, playing]);

  const classLayer = useMemo(() => {
    if (!meta || !projectOn3d || viewMode !== "class" || !classTraces?.length) return undefined;
    const classValues = classTraces.map((t) => t.value).sort((a, b) => a - b);
    const ticks = pickClassTicks(classValues, 12);
    const tickText = ticks.map((v) => formatClassLabel(varId, v, classInterval, false));
    return {
      enabled: true,
      varLabel: range.title,
      points: classTraces,
      markerSize: playing ? 2.2 : 2.8,
      opacity: 0.7,
      showLegend: true,
      cmin: classMin,
      cmax: classMax,
      colorscale: makeClassDiscreteColorscale(classValues, classMin, classMax, fieldPalette),
      showScale: showColorbarActive,
      colorbarTitle: `${range.title} class`,
      colorbarTicks: ticks,
      colorbarTickText: tickText,
      colorbarLen: mainColorbarLayout.len,
      colorbarX: mainColorbarLayout.x,
      colorbarY: mainColorbarLayout.y,
    };
  }, [
    classInterval,
    classMax,
    classMin,
    classTraces,
    fieldPalette,
    mainColorbarLayout.len,
    mainColorbarLayout.x,
    mainColorbarLayout.y,
    meta,
    playing,
    projectOn3d,
    range.title,
    showColorbarActive,
    varId,
    viewMode,
  ]);

  const eddyLayer = useMemo(() => {
    if (!meta || !projectOn3d || viewMode !== "eddies" || !eddyDetection || !eddyVolume) return undefined;
    const detectionPlaneZ = Number(meta.z[eddyDepthIdx] ?? EDDY_DETECTION_DEPTH_M);
    const trackZ = detectionPlaneZ + EDDY_TRACK_OFFSET_M;
    const digits = varId === "T" ? 2 : 3;
    const volumeById = new Map(eddyVolume.map((cluster) => [cluster.id, cluster] as const));
    const clusters: EddyClusterRender[] = eddyDetection.clusters.flatMap((cluster) => {
      const volume = volumeById.get(cluster.id);
      if (!volume) return [];
      const kindLabel = cluster.kind === "warm" ? "Warm" : "Cold";
      const hoverText =
        `${kindLabel} eddy<br>` +
        `Lon ${cluster.centroidLon.toFixed(2)}°<br>` +
        `Lat ${cluster.centroidLat.toFixed(2)}°<br>` +
        `${range.title} at ${eddyDetectionDepthLabel}: ${cluster.meanValue.toFixed(digits)}<br>` +
        `Anomaly at ${eddyDetectionDepthLabel}: ${cluster.meanAnomaly.toFixed(digits)}<br>` +
        `Peak anomaly: ${cluster.peakAnomaly.toFixed(digits)}<br>` +
        `Radius: ${cluster.radiusKm.toFixed(0)} km<br>` +
        `3D depth range: ${Math.round(volume.maxDepth)} to ${Math.round(volume.minDepth)} m<br>` +
        `3D points: ${volume.pointCount}`;
      return [{
        id: cluster.id,
        kind: cluster.kind,
        x: volume.x,
        y: volume.y,
        z: volume.z.map((zValue) => zValue + EDDY_LAYER_OFFSET_M),
        trackX: cluster.trackX ?? [],
        trackY: cluster.trackY ?? [],
        trackZ: (cluster.trackX ?? []).map(() => trackZ),
        hoverText,
      }];
    });
    return {
      enabled: true,
      clusters,
      markerSize: playing ? 2.8 : 3.6,
      opacity: 0.9,
      trackOpacity: 0.8,
      showLegend: true,
    };
  }, [
    eddyDepthIdx,
    eddyDetection,
    eddyDetectionDepthLabel,
    eddyVolume,
    meta,
    playing,
    projectOn3d,
    range.title,
    varId,
    viewMode,
  ]);

  const resetColorScale = useCallback(() => {
    if (viewMode === "draw") setDrawAutoColorRangeEnabled(false);
    setColorSettings((prev) => ({ ...prev, [varId]: DEFAULT_COLOR_SETTINGS[varId] }));
    setFieldColormapByVar((prev) => ({ ...prev, [varId]: DEFAULT_FIELD_COLORMAP[varId] }));
  }, [setDrawAutoColorRangeEnabled, varId, viewMode]);

  const resetCamera = useCallback(() => {
    try {
      window.localStorage.removeItem("gs_scene_camera_v1");
    } catch {
      // ignore
    }
    setCameraResetNonce((n) => n + 1);
  }, []);

  const autoColorScaleFromFrame = useCallback(() => {
    if (viewMode === "draw") setDrawAutoColorRangeEnabled(false);
    const values =
      viewMode === "horizontal" || (viewMode === "draw" && !transectValuesMasked)
        ? horizontalValuesMasked
        : transectValuesMasked;
    if (!values) return;
    const mm = computeMinMax(values, { ignoreExactZero: varId === "S" });
    if (!mm) return;
    setColorSettings((prev) => ({
      ...prev,
      [varId]: {
        ...prev[varId],
        cmin: Number(mm.min.toFixed(3)),
        cmax: Number(mm.max.toFixed(3)),
      },
    }));
  }, [horizontalValuesMasked, setDrawAutoColorRangeEnabled, transectValuesMasked, varId, viewMode]);

  return (
    <div className="app">
      <Basemap3D
        bathySource="bathy"
        bathyPalette={bathyPalette}
        bathyOpacity={drawTransectComplete ? 0.22 : 1}
        compactLayout={isMobileViewport}
        cameraFocusPath={drawCameraFocusPath}
        cameraResetNonce={cameraResetNonce}
        depthRatio={depthRatio}
        depthWarp={{ mode: depthWarpMode, focusDepthM: depthFocusM, deepRatio }}
        showBathy={showBathy}
        onStatusChange={handleStatusChange}
        showBathyContours={showBathyContours}
        showFieldContours={showFieldContours}
        horizontalField={horizontalField}
        horizontalPlanes={horizontalPlanes}
        guidePath={drawGuidePath}
        windLayer={windLayer}
        classLayer={classLayer}
        eddyLayer={eddyLayer}
        transectField={transectField}
        onSurfacePick={handleDrawSurfacePick}
        onSurfaceHover={handleDrawSurfaceHover}
      />

      <div className="overlay">
        {!panelOpen ? (
          <button
            type="button"
            className="panelOpenButton"
            title="Open control panel"
            onClick={() => setPanelOpen(true)}
          >
            ☰
          </button>
        ) : (
          <div
            ref={panelRef}
            className="panel controlPanel"
            style={{
              left: panelPos?.left ?? (isMobileViewport ? 12 : 16),
              ...(panelPos
                ? { top: panelPos.top }
                : isMobileViewport
                  ? { top: 12 }
                  : { bottom: 16 }),
            }}
          >
            <div
              className="panelHeader"
              title="Drag to move (double-click to reset)"
              onDoubleClick={() => setPanelPos(null)}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement | null)?.closest?.("button")) return;
                const el = panelRef.current;
                if (!el) return;
                const rect = el.getBoundingClientRect();
                const startOffsetX = e.clientX - rect.left;
                const startOffsetY = e.clientY - rect.top;

                const onMove = (ev: PointerEvent) => {
                  const el2 = panelRef.current;
                  if (!el2) return;
                  const rect2 = el2.getBoundingClientRect();
                  const nextLeft = ev.clientX - startOffsetX;
                  const nextTop = ev.clientY - startOffsetY;
                  const maxLeft = Math.max(12, window.innerWidth - rect2.width - 12);
                  const maxTop = Math.max(12, window.innerHeight - rect2.height - 12);
                  setPanelPos({
                    left: clamp(nextLeft, 12, maxLeft),
                    top: clamp(nextTop, 12, maxTop),
                  });
                };

                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  window.removeEventListener("pointercancel", onUp);
                };

                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
                window.addEventListener("pointercancel", onUp);
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Control Panel</div>
                <button
                  type="button"
                  className="panelIconButton"
                  title="Reset 3D view"
                  onClick={resetCamera}
                >
                  ⟲
                </button>
                <button
                  type="button"
                  className="panelIconButton"
                  title={themeMode === "night" ? "Switch to day mode" : "Switch to night mode"}
                  onClick={() => setThemeMode((m) => (m === "night" ? "day" : "night"))}
                >
                  {themeMode === "night" ? "☀" : "☾"}
                </button>
              </div>
              <div className="panelHeaderRight">
                <div className="badge">Local</div>
                <button
                  type="button"
                  className="panelIconButton"
                  title="Close"
                  onClick={() => setPanelOpen(false)}
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="title" style={{ marginBottom: 0 }}>
              <div>
                <h1>Nordic Seas</h1>
                {/* <div className="sub">T/S + sea ice over 3D bathymetry</div> */}
              </div>
            </div>

            <div className="controls">
              <details className="section" open>
                <summary>View</summary>
                <div className="sectionBody">
                  <div className="tabs">
                    <button
                      className={`tab ${viewMode === "horizontal" ? "tabActive" : ""}`}
                      onClick={() => setViewMode("horizontal")}
                      onMouseEnter={() => setViewModeHover("horizontal")}
                      onMouseLeave={() => setViewModeHover(null)}
                      onFocus={() => setViewModeHover("horizontal")}
                      onBlur={() => setViewModeHover(null)}
                      title={VIEW_MODE_DESCRIPTIONS.horizontal}
                    >
                      Horizontal
                    </button>
                    <button
                      className={`tab ${viewMode === "transect" ? "tabActive" : ""}`}
                      onClick={() => setViewMode("transect")}
                      onMouseEnter={() => setViewModeHover("transect")}
                      onMouseLeave={() => setViewModeHover(null)}
                      onFocus={() => setViewModeHover("transect")}
                      onBlur={() => setViewModeHover(null)}
                      title={VIEW_MODE_DESCRIPTIONS.transect}
                    >
                      Zonal
                    </button>
                    <button
                      className={`tab ${viewMode === "draw" ? "tabActive" : ""}`}
                      onClick={() => setViewMode("draw")}
                      onMouseEnter={() => setViewModeHover("draw")}
                      onMouseLeave={() => setViewModeHover(null)}
                      onFocus={() => setViewModeHover("draw")}
                      onBlur={() => setViewModeHover(null)}
                      title={VIEW_MODE_DESCRIPTIONS.draw}
                    >
                      Draw
                    </button>
                    <button
                      className={`tab ${viewMode === "class" ? "tabActive" : ""}`}
                      onClick={() => setViewMode("class")}
                      onMouseEnter={() => setViewModeHover("class")}
                      onMouseLeave={() => setViewModeHover(null)}
                      onFocus={() => setViewModeHover("class")}
                      onBlur={() => setViewModeHover(null)}
                      title={VIEW_MODE_DESCRIPTIONS.class}
                    >
                      Class
                    </button>
                  </div>
                  <div className="hint">{viewModeDescription}</div>

                  <label>
                    Variable
                    <select value={varId} onChange={(e) => setVarId(e.target.value as VarId)}>
                      {meta?.variables?.map((v) => (
                        <option key={v.id} value={v.id} disabled={!v.available}>
                          {v.label}
                          {!v.available ? " (missing in selected Zarr)" : ""}
                        </option>
                      )) ?? (
                        <>
                          <option value="T">Temperature (T)</option>
                          <option value="S">Salinity (S)</option>
                        </>
                      )}
                    </select>
                  </label>

                  <label>
                    Overlay opacity
                    <select
                      value={String(overlayOpacity)}
                      onChange={(e) => setOverlayOpacity(Number(e.target.value))}
                      disabled={!projectOn3d}
                    >
                      <option value="0.65">0.65</option>
                      <option value="0.75">0.75</option>
                      <option value="0.85">0.85</option>
                      <option value="0.9">0.90</option>
                      <option value="0.95">0.95</option>
                      <option value="1">1.00</option>
                    </select>
                  </label>

                  <div className="toggleRow">
                    <div>Colorbar</div>
                    <ToggleSwitch checked={showColorbar} onCheckedChange={setShowColorbar} />
                  </div>
                  <div className="toggleRow">
                    <div>Field contours</div>
                    <ToggleSwitch checked={showFieldContours} onCheckedChange={setShowFieldContours} />
                  </div>
                  <div className="toggleRow">
                    <div>Bathy</div>
                    <ToggleSwitch checked={showBathy} onCheckedChange={setShowBathy} />
                  </div>
                  <div className="toggleRow">
                    <div>Bathy contours</div>
                    <ToggleSwitch checked={showBathyContours} onCheckedChange={setShowBathyContours} />
                  </div>
                  <div className="toggleRow">
                    <div>Sea ice</div>
                    <ToggleSwitch checked={showSeaIce} onCheckedChange={setShowSeaIce} />
                  </div>
                  <div className="toggleRow">
                    <div>GSR mask</div>
                    <ToggleSwitch checked={showGsrMask} onCheckedChange={setShowGsrMask} />
                  </div>
                  <div className="toggleRow">
                    <div>Greenland Sea mask</div>
                    <ToggleSwitch checked={showGreenlandSeaMask} onCheckedChange={setShowGreenlandSeaMask} />
                  </div>
                  <div className="toggleRow">
                    <div>Iceland Sea mask</div>
                    <ToggleSwitch checked={showIcelandSeaMask} onCheckedChange={setShowIcelandSeaMask} />
                  </div>
                  <div className="toggleRow">
                    <div>Norwegian Sea mask</div>
                    <ToggleSwitch checked={showNorwegianSeaMask} onCheckedChange={setShowNorwegianSeaMask} />
                  </div>
                  <div className="hint">Turn on a mask to hide that subdomain; none selected = full domain.</div>
                  {allSubdomainMasksEnabled ? (
                    <div className="hint" style={{ color: "rgba(255,196,120,0.96)" }}>
                      All four masks are on, so Temperature/Salinity are hidden everywhere.
                    </div>
                  ) : null}
                  {anySubdomainMaskEnabled ? (
                    <button
                      type="button"
                      className="tab"
                      onClick={() => {
                        setShowGsrMask(false);
                        setShowGreenlandSeaMask(false);
                        setShowIcelandSeaMask(false);
                        setShowNorwegianSeaMask(false);
                      }}
                    >
                      Show all basins
                    </button>
                  ) : null}
                  {WIND_FEATURE_AVAILABLE ? (
                    <div className="toggleRow">
                      <div>Wind stress on ocean</div>
                      <ToggleSwitch checked={showWind} onCheckedChange={setShowWind} />
                    </div>
                  ) : null}
                  <div className="toggleRow">
                    <div>Movie</div>
                    <ToggleSwitch
                      checked={playing}
                      onCheckedChange={setPlaying}
                      disabled={metaStatus !== "ready" || !timeList.length}
                    />
                  </div>

                  <label>
                    Time ({activeTimeLabel})
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, timeList.length - 1)}
                      value={safeTimeIdx}
                      onChange={(e) => setTimeIdx(Number(e.target.value))}
                      style={{ width: "100%" }}
                      disabled={metaStatus !== "ready" || !timeList.length}
                    />
                    {timeList.length ? (
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 11,
                          color: "rgba(255,255,255,0.62)",
                          marginTop: 4,
                        }}
                      >
                        <span>{timeList[0]}</span>
                        <span>{timeList[timeList.length - 1]}</span>
                      </div>
                    ) : null}
                  </label>

                  <label>
                    FPS
                    <select value={String(fps)} onChange={(e) => setFps(Number(e.target.value))}>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                    </select>
                  </label>
                </div>
              </details>

              <details className="section" open>
                <summary>Slice</summary>
                <div className="sectionBody">
                  {viewMode === "horizontal" || viewMode === "draw" ? (
                    <>
                      <label>
                        Depth ({activeDepthLabel})
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0, zList.length - 1)}
                          value={safeDepthIdx}
                          onChange={(e) => setDepthIdx(Number(e.target.value))}
                          style={{ width: "100%" }}
                          disabled={metaStatus !== "ready" || !zList.length}
                        />
                        {zList.length ? (
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 11,
                              color: "rgba(255,255,255,0.62)",
                              marginTop: 4,
                            }}
                          >
                            <span>{Math.round(zList[0])} m</span>
                            <span>{Math.round(zList[zList.length - 1])} m</span>
                          </div>
                        ) : null}
                      </label>
                      {viewMode === "draw" ? (
                        <>
                          <div style={{ display: "flex", gap: 10 }}>
                            <button
                              type="button"
                              className="tab"
                              style={{ flex: 1 }}
                              disabled={metaStatus !== "ready"}
                              onClick={() => {
                                setDrawTransectPoints([]);
                                setDrawTransectHoverPoint(null);
                                setDrawTransectArmed(true);
                              }}
                            >
                              {drawTransectArmed
                                ? "Click the map…"
                                : drawTransectPoints.length >= 2
                                  ? "Redraw line"
                                  : "Draw line"}
                            </button>
                            <button
                              type="button"
                              className="tab"
                              style={{ flex: 1 }}
                              disabled={!drawTransectPoints.length && !drawTransectArmed}
                              onClick={() => {
                                setDrawTransectArmed(false);
                                setDrawTransectPoints([]);
                                setDrawTransectHoverPoint(null);
                              }}
                            >
                              Clear
                            </button>
                          </div>
                          <div className="hint">{drawTransectHint}</div>
                          {drawTransectPoints[0] ? (
                            <div className="hint">
                              Start: {drawTransectPoints[0].lon.toFixed(2)}°, {drawTransectPoints[0].lat.toFixed(2)}°N
                            </div>
                          ) : null}
                          {drawTransectPoints[1] ? (
                            <div className="hint">
                              End: {drawTransectPoints[1].lon.toFixed(2)}°, {drawTransectPoints[1].lat.toFixed(2)}°N
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </>
                  ) : viewMode === "eddies" ? (
                    <>
                      <label>
                        Detection depth ({eddyDetectionDepthLabel})
                      <div className="hint">
                        Eddy footprints are identified from {range.title.toLowerCase()} anomalies at the nearest
                        model level to 1000 m, then only the largest eddy in the configured domain is retained and
                        extended through the 3D field at the current time.
                      </div>
                      </label>
                      <label>
                        Eddy threshold (|anomaly|)
                        <input
                          type="text"
                          inputMode="decimal"
                          value={eddyThresholdInputByVar[varId] ?? String(eddyThreshold)}
                          onInput={(e) =>
                            updateEddyThresholdInputLive((e.target as HTMLInputElement).value)
                          }
                          onBlur={commitEddyThresholdInput}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEddyThresholdInput();
                          }}
                        />
                        <div className="hint">Higher values keep only stronger eddies.</div>
                      </label>
                      <label>
                        Track length (frames) ({eddyTrackHistory})
                        <input
                          type="range"
                          min={1}
                          max={eddyTrackHistoryMax}
                          step={1}
                          value={Math.min(eddyTrackHistory, eddyTrackHistoryMax)}
                          onChange={(e) => setEddyTrackLength(Number(e.target.value))}
                          style={{ width: "100%" }}
                          disabled={metaStatus !== "ready" || !timeList.length}
                        />
                      </label>
                      <label>
                        Minimum eddy size (cells) ({eddyMinCellCount})
                        <input
                          type="range"
                          min={6}
                          max={120}
                          step={2}
                          value={eddyMinCellCount}
                          onChange={(e) => setEddyMinCells(Number(e.target.value))}
                          style={{ width: "100%" }}
                        />
                        <div className="hint">Removes tiny noisy features.</div>
                      </label>
                      <div className="hint" style={{ marginTop: 6 }}>
                        Domain largest eddy: {eddyDetection?.clusters.length ? "found" : "none"} at threshold{" "}
                        {Number.isFinite(Number(eddyDetection?.threshold))
                          ? Number(eddyDetection?.threshold).toFixed(varId === "T" ? 2 : 3)
                          : "n/a"}.
                      </div>
                      <div className="hint">
                        Domain bounds: lon {BOREAS_BASIN_BOUNDS.lonMin} to {BOREAS_BASIN_BOUNDS.lonMax}°, lat{" "}
                        {BOREAS_BASIN_BOUNDS.latMin} to {BOREAS_BASIN_BOUNDS.latMax}°N.
                      </div>
                    </>
                  ) : viewMode === "transect" ? (
                    <label>
                      Latitude target (°N) ({latTarget.toFixed(2)}°N)
                      <input
                        type="range"
                        min={latMin}
                        max={latMax}
                        step={0.01}
                        value={latTarget}
                        onChange={(e) => setLatTarget(Number(e.target.value))}
                        style={{ width: "100%" }}
                        disabled={metaStatus !== "ready"}
                      />
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 11,
                          color: "rgba(255,255,255,0.62)",
                          marginTop: 4,
                        }}
                      >
                        <span>{latMin.toFixed(1)}°N</span>
                        <span>{latMax.toFixed(1)}°N</span>
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <input
                          type="number"
                          value={latTargetInput}
                          min={latMin}
                          max={latMax}
                          step={0.05}
                          onChange={(e) => setLatTargetInput(e.target.value)}
                          onBlur={commitLatTargetInput}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitLatTargetInput();
                          }}
                          disabled={metaStatus !== "ready"}
                        />
                      </div>
                      {transectLatActual != null ? (
                        <div className="hint">Nearest model latitude: {transectLatActual.toFixed(3)}°N</div>
                      ) : null}
                    </label>
                  ) : (
                    <>
                      <label>
                        Class min
                        <input
                          type="text"
                          inputMode="decimal"
                          value={classInputs?.min ?? String(classSettings.min)}
                          onInput={(e) => updateClassInputLive("min", (e.target as HTMLInputElement).value)}
                          onBlur={() => commitClassInput("min")}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitClassInput("min");
                          }}
                        />
                      </label>
                      <label>
                        Class max
                        <input
                          type="text"
                          inputMode="decimal"
                          value={classInputs?.max ?? String(classSettings.max)}
                          onInput={(e) => updateClassInputLive("max", (e.target as HTMLInputElement).value)}
                          onBlur={() => commitClassInput("max")}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitClassInput("max");
                          }}
                        />
                      </label>
                      <label>
                        Class interval
                        <select
                          value={String(classInterval)}
                          onChange={(e) =>
                            setClassSettingsByVar((prev) => ({
                              ...prev,
                              [varId]: { ...prev[varId], interval: Number(e.target.value) },
                            }))
                          }
                        >
                          {CLASS_INTERVAL_OPTIONS[varId].map((opt) => (
                            <option key={opt} value={String(opt)}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Class half-width
                        <select
                          value={String(classHalfWidth)}
                          onChange={(e) =>
                            setClassSettingsByVar((prev) => ({
                              ...prev,
                              [varId]: { ...prev[varId], halfWidth: Number(e.target.value) },
                            }))
                          }
                        >
                          {CLASS_HALF_WIDTH_OPTIONS[varId].map((opt) => (
                            <option key={opt} value={String(opt)}>
                              {opt}
                            </option>
                          ))}
                        </select>
                        <div className="hint">
                          Showing {range.title} classes in [{classMin}, {classMax}].
                        </div>
                        <div className="hint">
                          Effective half-width: +/-{classHalfWidthEffective.toFixed(2)}{" (auto >= interval/2)."}
                        </div>
                      </label>
                      <label>
                        Class density ({clampClassDensity(classDensity).toFixed(2)}x)
                        <input
                          type="range"
                          min={CLASS_DENSITY_MIN}
                          max={CLASS_DENSITY_MAX}
                          step={CLASS_DENSITY_STEP}
                          value={clampClassDensity(classDensity)}
                          onChange={(e) => setClassDensity(clampClassDensity(Number(e.target.value)))}
                          style={{ width: "100%" }}
                        />
                        <div className="hint">Lower is faster/sparser; higher is denser/slower.</div>
                      </label>
                      <button
                        type="button"
                        className="tab"
                        onClick={() => {
                          setClassSettingsByVar((prev) => ({
                            ...prev,
                            [varId]: DEFAULT_CLASS_SETTINGS[varId],
                          }));
                          setClassInputByVar((prev) => ({
                            ...prev,
                            [varId]: {
                              min: String(DEFAULT_CLASS_SETTINGS[varId].min),
                              max: String(DEFAULT_CLASS_SETTINGS[varId].max),
                            },
                          }));
                          setClassDensity(CLASS_DENSITY_DEFAULT);
                        }}
                      >
                        Reset class defaults
                      </button>
                    </>
                  )}

                  <label>
                    Depth ratio (z) ({depthRatio.toFixed(2)})
                    <input
                      type="range"
                      min={0.15}
                      max={1.5}
                      step={0.05}
                      value={depthRatio}
                      onChange={(e) => setDepthRatio(Number(e.target.value))}
                      style={{ width: "100%" }}
                    />
                    <div className="hint">Vertical exaggeration.</div>
                  </label>

                  <label>
                    Depth scaling
                    <select value={depthWarpMode} onChange={(e) => setDepthWarpMode(e.target.value as any)}>
                      <option value="upper">Upper-focus (e.g., top 2500 m)</option>
                      <option value="linear">Linear</option>
                    </select>
                  </label>

                  {depthWarpMode === "upper" ? (
                    <>
                      <label>
                        Focus depth (m) ({Math.round(depthFocusM)} m)
                        <input
                          type="range"
                          min={500}
                          max={6000}
                          step={100}
                          value={depthFocusM}
                          onChange={(e) => setDepthFocusM(Number(e.target.value))}
                          style={{ width: "100%" }}
                        />
                        <div className="hint">Upper layer stays linear; deeper layers are compressed.</div>
                      </label>
                      <label>
                        Deep ratio ({deepRatio.toFixed(2)})
                        <input
                          type="range"
                          min={0.05}
                          max={1}
                          step={0.05}
                          value={deepRatio}
                          onChange={(e) => setDeepRatio(Number(e.target.value))}
                          style={{ width: "100%" }}
                        />
                        <div className="hint">Lower compresses deep ocean (below focus depth).</div>
                      </label>
                    </>
                  ) : null}

                </div>
              </details>

              <details className="section">
                <summary>Color scale</summary>
                <div className="sectionBody">
                  {viewMode === "eddies" ? (
                    <div className="hint">
                      Eddy mode uses fixed warm/cold anomaly colors. Variable choice still controls the detector.
                    </div>
                  ) : null}
                  <label>
                    {varId === "T" ? "Temperature colormap" : "Salinity colormap"}
                    <select
                      value={fieldColormapByVar[varId]}
                      onChange={(e) =>
                        setFieldColormapByVar((prev) => ({
                          ...prev,
                          [varId]: e.target.value as FieldColormapId,
                        }))
                      }
                    >
                      {FIELD_COLORMAP_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Bathymetry colormap
                    <select
                      value={bathyColormap}
                      onChange={(e) => setBathyColormap(e.target.value as BathyColormapId)}
                    >
                      {BATHY_COLORMAP_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {viewMode === "draw" ? (
                    <>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          justifyContent: "space-between",
                        }}
                      >
                        <span>Auto range from transect</span>
                        <ToggleSwitch
                          checked={drawAutoColorRangeByVar[varId]}
                          onCheckedChange={(checked) => setDrawAutoColorRangeEnabled(checked)}
                        />
                      </label>
                      <div className="hint">
                        {drawTransectAutoRange
                          ? `Current transect range: ${drawTransectAutoRange.min.toFixed(3)} to ${drawTransectAutoRange.max.toFixed(3)}. Turn this off to use Min/Max below.`
                          : "Finish drawing a transect to enable automatic draw-range scaling."}
                      </div>
                    </>
                  ) : null}

                  <div style={{ display: "flex", gap: 10 }}>
                    <label style={{ flex: 1 }}>
                      Min
                      <input
                        type="text"
                        inputMode="decimal"
                        value={drawDisplayedColorInput?.min ?? colorInputs?.min ?? String(settings.cmin)}
                        disabled={drawAutoColorRangeActive}
                        onInput={(e) => updateColorInputLive("min", (e.target as HTMLInputElement).value)}
                        onBlur={() => commitColorInput("min")}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitColorInput("min");
                        }}
                      />
                    </label>
                    <label style={{ flex: 1 }}>
                      Max
                      <input
                        type="text"
                        inputMode="decimal"
                        value={drawDisplayedColorInput?.max ?? colorInputs?.max ?? String(settings.cmax)}
                        disabled={drawAutoColorRangeActive}
                        onInput={(e) => updateColorInputLive("max", (e.target as HTMLInputElement).value)}
                        onBlur={() => commitColorInput("max")}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitColorInput("max");
                        }}
                      />
                    </label>
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    <button type="button" className="tab" onClick={resetColorScale} style={{ flex: 1 }}>
                      Reset default
                    </button>
                    <button
                      type="button"
                      className="tab"
                      onClick={autoColorScaleFromFrame}
                      style={{ flex: 1 }}
                      disabled={sliceStatus !== "ready"}
                      title={sliceStatus !== "ready" ? "Load a slice first" : "Auto range from current frame"}
                    >
                      Auto (frame)
                    </button>
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    <label style={{ flex: 1 }}>
                      Ticks
                      <select
                        value={String(settings.tickCount)}
                        onChange={(e) =>
                          setColorSettings((prev) => ({
                            ...prev,
                            [varId]: { ...prev[varId], tickCount: Number(e.target.value) },
                          }))
                        }
                      >
                        <option value="0">Auto</option>
                        {TICK_OPTIONS_BY_VAR[varId].map((count) => (
                          <option key={count} value={String(count)}>
                            {count}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label style={{ flex: 1 }}>
                      Mode
                      <select
                        value={settings.mode}
                        onChange={(e) =>
                          setColorSettings((prev) => ({
                            ...prev,
                            [varId]: { ...prev[varId], mode: e.target.value as ColorscaleMode },
                          }))
                        }
                      >
                        <option value="continuous">Continuous</option>
                        <option value="discrete">Discrete</option>
                      </select>
                    </label>
                  </div>

                  {settings.mode === "discrete" ? (
                    <label>
                      Levels
                      <select
                        value={String(settings.levels)}
                        onChange={(e) =>
                          setColorSettings((prev) => ({
                            ...prev,
                            [varId]: { ...prev[varId], levels: Number(e.target.value) },
                          }))
                        }
                      >
                        <option value="8">8</option>
                        <option value="12">12</option>
                        <option value="16">16</option>
                        <option value="24">24</option>
                        <option value="32">32</option>
                      </select>
                    </label>
                  ) : null}

                  <div className="hint">
                    Default: <b>[{DEFAULT_COLOR_SETTINGS[varId].cmin}, {DEFAULT_COLOR_SETTINGS[varId].cmax}]</b>
                  </div>
                </div>
              </details>

              <details className="section">
                <summary>Status</summary>
                <div className="sectionBody">
                  <div className="hint">
                    Dataset: <b>{meta?.storeUrl ? meta.storeUrl.split("/").slice(-1)[0] : "public/data/nordic.zarr"}</b> — meta{" "}
                    <b>{metaStatus}</b>
                    {metaStatus === "failed" && metaError ? <div style={{ marginTop: 6 }}>Error: {metaError}</div> : null}
                  </div>

                  <div className="hint">
                    Slice: <b>{sliceStatus}</b>
                    {sliceStatus === "failed" && sliceError ? <div style={{ marginTop: 6 }}>Error: {sliceError}</div> : null}
                  </div>
                  {viewMode === "draw" ? (
                    <div className="hint">
                      Draw transect: <b>{drawTransectPoints.length >= 2 ? `${drawTransectLengthKm.toFixed(0)} km ready` : drawTransectArmed ? "awaiting clicks" : "no line"}</b>
                    </div>
                  ) : null}
                  <div className="hint">
                    Class: <b>{viewMode === "class" ? classStatus : "off"}</b>
                    {classStatus === "failed" && classError ? <div style={{ marginTop: 6 }}>Error: {classError}</div> : null}
                  </div>
                  <div className="hint">
                    Eddies: <b>{viewMode === "eddies" ? eddyStatus : "off"}</b>
                    {eddyStatus === "failed" && eddyError ? <div style={{ marginTop: 6 }}>Error: {eddyError}</div> : null}
                  </div>

                  <div className="hint">
                    Sea ice: <b>{showSeaIce ? seaIceStatus : "off"}</b>
                    {seaIceStatus === "failed" && seaIceError ? <div style={{ marginTop: 6 }}>Error: {seaIceError}</div> : null}
                  </div>
                  <div className="hint">
                    Masked subdomains:{" "}
                    <b>
                      {[
                        showGsrMask ? "GSR" : null,
                        showGreenlandSeaMask ? "Greenland Sea" : null,
                        showIcelandSeaMask ? "Iceland Sea" : null,
                        showNorwegianSeaMask ? "Norwegian Sea" : null,
                      ]
                        .filter(Boolean)
                        .join(", ") || "none"}
                    </b>
                  </div>

                  {WIND_FEATURE_AVAILABLE ? (
                    <div className="hint">
                      Wind stress on ocean: <b>{showWind ? windStatus : "off"}</b>
                      {windStatus === "failed" && windError ? <div style={{ marginTop: 6 }}>Error: {windError}</div> : null}
                    </div>
                  ) : null}

                  <div className="hint">
                    3D: Plotly <b>{bathyInfo.plotly}</b>, bathymetry <b>{bathyInfo.bathy}</b>.
                  </div>
                </div>
              </details>

              <div className="section">
                <div className="sectionBody">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontSize: 12, opacity: 0.75 }}>Feedback:</div>
                    <a
                      href="https://bve23zsu.github.io/"
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Webpage"
                      title="Webpage"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        color: "white",
                        textDecoration: "none",
                        fontSize: 12,
                        opacity: 0.8,
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm6.93 9h-3.16a15.7 15.7 0 00-1.38-5.03A8.03 8.03 0 0118.93 11zM12 4.04c.86 1.16 1.78 3.27 2.15 6.96H9.85C10.22 7.31 11.14 5.2 12 4.04zM4.07 13h3.16c.14 1.86.6 3.62 1.38 5.03A8.03 8.03 0 014.07 13zm3.16-2H4.07a8.03 8.03 0 014.54-5.03A15.7 15.7 0 007.23 11zM12 19.96c-.86-1.16-1.78-3.27-2.15-6.96h4.31c-.37 3.69-1.29 5.8-2.16 6.96zM14.77 13h3.16a8.03 8.03 0 01-4.54 5.03c.78-1.41 1.24-3.17 1.38-5.03z" />
                      </svg>
                    </a>
                    <a
                      href="https://github.com/greenlandsea/greenlandsea.github.io"
                      target="_blank"
                      rel="noreferrer"
                      aria-label="GitHub"
                      title="GitHub"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        color: "white",
                        textDecoration: "none",
                        fontSize: 12,
                        opacity: 0.8,
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.21.68-.48v-1.68c-2.78.6-3.37-1.18-3.37-1.18-.46-1.15-1.11-1.46-1.11-1.46-.91-.61.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.64.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0112 6.84c.85 0 1.71.11 2.51.33 1.91-1.3 2.75-1.03 2.75-1.03.55 1.37.2 2.39.1 2.64.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.86v2.76c0 .27.18.57.69.47A10 10 0 0012 2z" />
                      </svg>
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
