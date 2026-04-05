import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Basemap3D from "./components/Basemap3D";
import BasemapThree from "./components/BasemapThree";
import {
  CMOCEAN_COLORMAP_IDS,
  bed_elevation_256,
  blues_r_256,
  cmocean_256,
  grayscale_256,
  ice_256,
  isCmoceanColormapId,
  paletteToColorscale,
  plasma_256,
  rdylbu_r_256,
  viridis_256,
  type CmoceanColormapId,
  type RGB,
} from "./lib/colormap";
import { formatColorbarTickText } from "./lib/colorbar";
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
type Renderer3D = "plotly" | "three";
type PanelResizeCorner = "nw" | "ne" | "sw" | "se";
type VarId = "T" | "S";
type ColorscaleMode = "continuous" | "discrete";
type ExtraFieldColormapId = "rdylbu_r" | "viridis" | "plasma";
type FieldColormapId = CmoceanColormapId | ExtraFieldColormapId;
type BathySourceId = "model" | "rtopo";
type BathyColormapId = CmoceanColormapId | "bed_elevation" | "blues_r" | "viridis" | "grayscale";

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
    "Horizontal: view the selected variable on a constant-depth map slice. Select depth under Tempo-spatial, define color scheme under Color scale.",
  transect:
    "Zonal: view the selected variable on a west-east section at a chosen latitude. Slice the latitude target under Tempo-spatial, define color scheme under Color scale.",
  draw:
    "Draw: sample the selected variable along an arbitrary line between two map points. Set depth and draw the line under View, define color scheme under Color scale.",
  class:
    "Class: show 3D point clouds for value bands through the water column. Set class range and density under View, define color scheme under Color scale.",
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
const TRANSECT_SLICE_STEP_DEG = 0.2;
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
    title: "Modeled Salinity",
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

const CMOCEAN_COLORMAP_OPTIONS = CMOCEAN_COLORMAP_IDS.map((id) => ({
  id,
  label: `cmocean.cm.${id}`,
})) as ReadonlyArray<{ id: CmoceanColormapId; label: string }>;

const FIELD_COLORMAP_OPTIONS: Array<{ id: FieldColormapId; label: string }> = [
  ...CMOCEAN_COLORMAP_OPTIONS,
  { id: "rdylbu_r", label: "RdYlBu_r" },
  { id: "viridis", label: "Viridis" },
  { id: "plasma", label: "Plasma" },
];

const BATHY_SOURCE_OPTIONS: Array<{ id: BathySourceId; label: string; hint: string }> = [
  { id: "model", label: "MITgcm model grid", hint: "4.5-1 km model-grid bathymetry." },
  { id: "rtopo", label: 'RTopo-2.0.4 (30")', hint: "30 arcsec source, heavier but sharper." },
];

const BATHY_COLORMAP_OPTIONS: Array<{ id: BathyColormapId; label: string }> = [
  { id: "bed_elevation", label: "Bed relief" },
  ...CMOCEAN_COLORMAP_OPTIONS,
  { id: "grayscale", label: "Grayscale" },
  { id: "blues_r", label: "Blues_r" },
  { id: "viridis", label: "Viridis" },
];

const DEFAULT_FIELD_COLORMAP: Record<VarId, FieldColormapId> = {
  T: "rdylbu_r",
  S: "rdylbu_r",
};

const DEFAULT_BATHY_SOURCE: BathySourceId = "model";
const DEFAULT_BATHY_COLORMAP: BathyColormapId = "bed_elevation";

function paletteForColormapId(id: FieldColormapId | BathyColormapId): RGB[] {
  if (isCmoceanColormapId(id)) return cmocean_256(id);
  switch (id) {
    case "rdylbu_r":
      return rdylbu_r_256();
    case "viridis":
      return viridis_256();
    case "plasma":
      return plasma_256();
    case "bed_elevation":
      return bed_elevation_256();
    case "grayscale":
      return grayscale_256();
    case "blues_r":
      return blues_r_256();
    default:
      return cmocean_256("thermal");
  }
}

const FALLBACK_FIELD_PALETTE = cmocean_256("thermal");
const FALLBACK_FIELD_CONTINUOUS = paletteToColorscale(FALLBACK_FIELD_PALETTE);

const DEFAULT_COLOR_SETTINGS: Record<VarId, VarColorSettings> = {
  T: { cmin: -1, cmax: 8, tickCount: 10, mode: "continuous", levels: 12 },
  S: { cmin: 34, cmax: 35.6, tickCount: 9, mode: "continuous", levels: 12 },
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
const PANEL_SIZE_STORAGE_KEY = "gs_panel_size_v1";
const PANEL_MIN_WIDTH = 300;
const PANEL_MIN_HEIGHT = 320;
const PANEL_MAX_WIDTH = 620;
const PANEL_MAX_HEIGHT = 900;
const PANEL_FIXED_DESKTOP_WIDTH = 352;
const PANEL_SAFE_MIN_WIDTH = 240;
const PANEL_SAFE_MIN_HEIGHT = 280;
const PLOTLY_OVERVIEW_CAMERA = {
  eye: { x: 0.1, y: -1.95, z: 0.86 },
  up: { x: 0, y: 0, z: 1 },
};
const ZONAL_OVERVIEW_CAMERA = {
  eye: { x: 0.06, y: -1.65, z: 1.24 },
  up: { x: 0, y: 0, z: 1 },
};
function panelOpenStorageKey(isMobile: boolean) {
  return isMobile ? "gs_panel_open_mobile" : "gs_panel_open_desktop";
}

function clampPanelSize(
  size: { width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
  isMobile: boolean
) {
  const viewportMargin = isMobile ? 24 : 32;
  const availableWidth = Math.max(PANEL_SAFE_MIN_WIDTH, viewportWidth - viewportMargin);
  const availableHeight = Math.max(PANEL_SAFE_MIN_HEIGHT, viewportHeight - viewportMargin);
  const minWidth = Math.min(PANEL_MIN_WIDTH, availableWidth);
  const minHeight = Math.min(PANEL_MIN_HEIGHT, availableHeight);
  const maxWidth = isMobile
    ? Math.max(minWidth, Math.min(PANEL_MAX_WIDTH, availableWidth))
    : Math.max(minWidth, Math.min(PANEL_FIXED_DESKTOP_WIDTH, availableWidth));
  const maxHeight = Math.max(minHeight, Math.min(PANEL_MAX_HEIGHT, availableHeight));
  return {
    width: isMobile ? clamp(size.width, minWidth, maxWidth) : maxWidth,
    height: clamp(size.height, minHeight, maxHeight),
  };
}

function defaultPanelSize(viewportWidth: number, viewportHeight: number, isMobile: boolean) {
  if (isMobile) {
    return clampPanelSize(
      {
        width: viewportWidth - 24,
        height: Math.max(420, viewportHeight - 24),
      },
      viewportWidth,
      viewportHeight,
      true
    );
  }
  return clampPanelSize(
    {
      width: PANEL_FIXED_DESKTOP_WIDTH,
      height: Math.max(640, viewportHeight - 32),
    },
    viewportWidth,
    viewportHeight,
    false
  );
}

function readPanelSize(viewportWidth: number, viewportHeight: number) {
  try {
    if (typeof window !== "undefined") {
      const isMobile = viewportWidth <= MOBILE_PANEL_BREAKPOINT_PX;
      const raw = window.localStorage.getItem(PANEL_SIZE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { width?: number; height?: number };
        const width = Number(parsed?.width);
        const height = Number(parsed?.height);
        if (Number.isFinite(width) && Number.isFinite(height)) {
          return clampPanelSize({ width, height }, viewportWidth, viewportHeight, isMobile);
        }
      }
      return defaultPanelSize(viewportWidth, viewportHeight, isMobile);
    }
  } catch {
    // ignore
  }
  return defaultPanelSize(viewportWidth, viewportHeight, viewportWidth <= MOBILE_PANEL_BREAKPOINT_PX);
}

function makeTicks(min: number, max: number, tickCount: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  if (tickCount <= 1 || min === max) return undefined;
  const span = max - min;
  const rawStep = Math.abs(span) / Math.max(1, tickCount - 1);
  const exponent = Math.floor(Math.log10(Math.max(rawStep, 1e-9)));
  const fraction = rawStep / 10 ** exponent;
  const niceFraction = fraction <= 1.5 ? 1 : fraction <= 3 ? 2 : fraction <= 4.5 ? 2.5 : fraction <= 7 ? 5 : 10;
  const step = niceFraction * 10 ** exponent;
  const start = Math.ceil(Math.min(min, max) / step) * step;
  const end = Math.floor(Math.max(min, max) / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step * 0.25; v += step) {
    out.push(Number(v.toFixed(6)));
    if (out.length >= 240) break;
  }
  if (out.length < 2) return [Number(min.toFixed(6)), Number(max.toFixed(6))].filter((v, i, arr) => arr.indexOf(v) === i);
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
  return varId === "T" ? `${text}°C` : text;
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

function rangeStepPrecision(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step).toLowerCase();
  const expIdx = text.indexOf("e-");
  if (expIdx >= 0) return Number(text.slice(expIdx + 2));
  const dotIdx = text.indexOf(".");
  return dotIdx >= 0 ? text.length - dotIdx - 1 : 0;
}

function nudgeRangeValue(value: number, direction: 1 | -1, min: number, max: number, step: number) {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const precision = Math.min(6, rangeStepPrecision(safeStep));
  const next = clamp(value + direction * safeStep, min, max);
  return Number(next.toFixed(precision));
}

function nudgeBoundedValue(
  value: number,
  direction: 1 | -1,
  step: number,
  lowerBound: number,
  upperBound: number
) {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const precision = Math.min(6, rangeStepPrecision(safeStep));
  const next = clamp(value + direction * safeStep, lowerBound, upperBound);
  return Number(next.toFixed(precision));
}

function RangeNudgeSlider(props: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  buttonLayout?: "vertical" | "horizontal";
  decreaseLabel?: string;
  increaseLabel?: string;
}) {
  const {
    min,
    max,
    step = 1,
    value,
    onChange,
    disabled,
    buttonLayout = "vertical",
    decreaseLabel = "v",
    increaseLabel = "^",
  } = props;
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const epsilon = safeStep * 0.25;
  const canDecrease = !disabled && value > min + epsilon;
  const canIncrease = !disabled && value < max - epsilon;

  const buttonStyle = { minWidth: 22, padding: "2px 5px", lineHeight: 1, fontWeight: 700 };

  if (buttonLayout === "horizontal") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          className="tab"
          style={buttonStyle}
          disabled={!canDecrease}
          onClick={() => onChange(nudgeRangeValue(value, -1, min, max, safeStep))}
          aria-label="Decrease slider value"
          title="Previous"
        >
          {decreaseLabel}
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={safeStep}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ width: "100%" }}
          disabled={disabled}
        />
        <button
          type="button"
          className="tab"
          style={buttonStyle}
          disabled={!canIncrease}
          onClick={() => onChange(nudgeRangeValue(value, 1, min, max, safeStep))}
          aria-label="Increase slider value"
          title="Next"
        >
          {increaseLabel}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={safeStep}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", flex: 1 }}
        disabled={disabled}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: "0 0 auto" }}>
        <button
          type="button"
          className="tab"
          style={buttonStyle}
          disabled={!canIncrease}
          onClick={() => onChange(nudgeRangeValue(value, 1, min, max, safeStep))}
          aria-label="Increase slider value"
          title="Increase"
        >
          {increaseLabel}
        </button>
        <button
          type="button"
          className="tab"
          style={buttonStyle}
          disabled={!canDecrease}
          onClick={() => onChange(nudgeRangeValue(value, -1, min, max, safeStep))}
          aria-label="Decrease slider value"
          title="Decrease"
        >
          {decreaseLabel}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastThreeViewportKeyRef = useRef<string>("");
  const [cameraResetNonce, setCameraResetNonce] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280
  );
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 900
  );
  const [isFullscreen, setIsFullscreen] = useState(() =>
    typeof document !== "undefined" ? Boolean(document.fullscreenElement) : false
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
  const [panelSize, setPanelSize] = useState(() =>
    typeof window !== "undefined"
      ? readPanelSize(window.innerWidth, window.innerHeight)
      : defaultPanelSize(1280, 900, false)
  );
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
    try {
      const isMobile = viewportWidth <= MOBILE_PANEL_BREAKPOINT_PX;
      const next = clampPanelSize(panelSize, viewportWidth, viewportHeight, isMobile);
      if (next.width !== panelSize.width || next.height !== panelSize.height) {
        setPanelSize(next);
      }
      window.localStorage.setItem(PANEL_SIZE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, [panelSize, viewportHeight, viewportWidth]);

  useEffect(() => {
    if (!panelPos) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(12, viewportWidth - rect.width - 12);
    const maxTop = Math.max(12, viewportHeight - rect.height - 12);
    const nextLeft = clamp(panelPos.left, 12, maxLeft);
    const nextTop = clamp(panelPos.top, 12, maxTop);
    if (nextLeft !== panelPos.left || nextTop !== panelPos.top) {
      setPanelPos({ left: nextLeft, top: nextTop });
    }
  }, [panelPos, viewportHeight, viewportWidth]);

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
    if (typeof document === "undefined") return;
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    onFs();
    return () => document.removeEventListener("fullscreenchange", onFs);
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
  const [overlayOpacity, setOverlayOpacity] = useState(0);
  const [showBathy, setShowBathy] = useState(true);
  const [depthRatio, setDepthRatio] = useState(0.5);
  const [isDepthScalePending, startDepthScaleTransition] = useTransition();
  const deferredDepthRatio = useDeferredValue(depthRatio);
  const [depthWarpMode, setDepthWarpMode] = useState<"linear" | "upper">("upper");
  const [depthFocusM, setDepthFocusM] = useState(1800);
  const [deepRatio, setDeepRatio] = useState(0.18);
  const [bathySource, setBathySource] = useState<BathySourceId>(DEFAULT_BATHY_SOURCE);
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
  const [showSeaIce, setShowSeaIce] = useState(false);
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
  const [plotlyCameraNonce, setPlotlyCameraNonce] = useState(0);
  useEffect(() => {
    setShowWind(false);
    if (viewMode !== "horizontal") {
      setPlotlyCameraNonce((value) => value + 1);
    }
  }, [viewMode]);
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
    horizontalImage: "off" | "loading" | "ready" | "failed";
    transectImage: "off" | "loading" | "ready" | "failed";
  }>({
    plotly: "loading",
    bathy: "loading",
    horizontalImage: "off",
    transectImage: "off",
  });

  const handleStatusChange = useCallback(
    (s: {
      plotly: "loading" | "ready" | "failed";
      bathy: "loading" | "file" | "synthetic";
      horizontalImage: "off" | "loading" | "ready" | "failed";
      transectImage: "off" | "loading" | "ready" | "failed";
    }) =>
      setBathyInfo({
        plotly: s.plotly,
        bathy: s.bathy,
        horizontalImage: s.horizontalImage,
        transectImage: s.transectImage,
      }),
    []
  );

  const range = useMemo(() => defaultRange(varId), [varId]);
  const settings = colorSettings[varId];
  const classSettings = classSettingsByVar[varId];
  const colorScaleUsesClassRange = viewMode === "class";
  const classInputs = classInputByVar[varId];
  const colorInputs = colorInputByVar[varId];
  const colorScaleStep = useMemo(() => {
    if (range.ticks.length >= 2) return Math.abs(range.ticks[1] - range.ticks[0]);
    return Math.max(0.01, (range.max - range.min) / 10);
  }, [range.max, range.min, range.ticks]);
  const tickCountOptions = useMemo(() => [0, ...TICK_OPTIONS_BY_VAR[varId]], [varId]);
  const tickCountIndex = tickCountOptions.indexOf(settings.tickCount);
  const safeTickCountIndex = tickCountIndex >= 0 ? tickCountIndex : 0;
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
  const panelBoxSize = clampPanelSize(panelSize, viewportWidth, viewportHeight, isMobileViewport);
  const panelDisplayHeight =
    isFullscreen && !isMobileViewport
      ? Math.max(PANEL_SAFE_MIN_HEIGHT, viewportHeight - 32)
      : panelBoxSize.height;
  const panelLeft = panelPos?.left ?? (isMobileViewport ? 12 : 16);
  const panelReservedLeftPx =
    panelOpen && !isMobileViewport && panelLeft <= 24 ? panelLeft + panelBoxSize.width + 18 : 0;
  const threeCameraAutoFitKey =
    `${viewportWidth}x${viewportHeight}|${panelOpen ? 1 : 0}|${bathySource}|${Math.round(panelReservedLeftPx)}`;
  const feedbackLabelColor =
    themeMode === "day" ? "rgba(15, 23, 42, 0.72)" : "rgba(241, 245, 249, 0.76)";
  const feedbackLinkColor =
    themeMode === "day" ? "rgba(15, 23, 42, 0.94)" : "rgba(248, 250, 252, 0.92)";

  useEffect(() => {
    if (viewMode !== "horizontal") return;
    const nextKey = `${viewportWidth}x${viewportHeight}|${panelOpen ? 1 : 0}`;
    if (lastThreeViewportKeyRef.current && lastThreeViewportKeyRef.current !== nextKey) {
      setCameraResetNonce((n) => n + 1);
    }
    lastThreeViewportKeyRef.current = nextKey;
  }, [panelOpen, viewMode, viewportHeight, viewportWidth]);
  const showColorbarActive = !(isMobilePortraitViewport && !panelOpen);
  const hasSeaIceColorbar = projectOn3d && showSeaIce && showColorbarActive;
  const scalarColorbarLen = hasSeaIceColorbar
    ? isMobileViewport
      ? 0.24
      : 0.24
    : isMobileViewport
      ? 0.66
      : 0.84;
  const mainColorbarLayout = useMemo(
    () =>
      hasSeaIceColorbar
        ? isMobileViewport
          ? { x: 0.985, y: 0.72, len: scalarColorbarLen }
          : { x: 1.03, y: 0.76, len: scalarColorbarLen }
        : isMobileViewport
          ? { x: 0.985, y: 0.50, len: 0.66 }
          : { x: 1.03, y: 0.50, len: 0.84 },
    [hasSeaIceColorbar, isMobileViewport, scalarColorbarLen]
  );
  const seaIceColorbarLayout = useMemo(
    () =>
      showColorbarActive
        ? isMobileViewport
          ? { x: 0.985, y: 0.42, len: scalarColorbarLen }
          : { x: 1.03, y: 0.46, len: scalarColorbarLen }
        : isMobileViewport
          ? { x: 0.985, y: 0.50, len: 0.66 }
          : { x: 1.03, y: 0.50, len: 0.84 },
    [isMobileViewport, scalarColorbarLen, showColorbarActive]
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
  const activeOverlaySummary = [
    showWind ? "wind stress on ocean" : null,
    showSeaIce ? "sea ice" : null,
  ].filter(Boolean) as string[];
  const activeOverlayText = activeOverlaySummary.length
    ? ` ${activeOverlaySummary.join(" and ")} ${activeOverlaySummary.length === 1 ? "is" : "are"} on.`
    : "";
  const horizontalModeLabel = overlayOpacity > 0.001 ? range.title : "Topography";
  const drawMapInstruction =
    drawTransectPoints.length >= 2
      ? `Draw mode is showing your transect cross-section at ${activeTimeLabel}. Click "Clear" in the panel to remove the line, then adjust the view angle and click "Draw line" for a new transect.${activeOverlayText}`
      : drawTransectArmed && drawTransectPoints.length === 1
        ? `Draw mode: move gently and slowly over the map, then click the end point.${activeOverlayText}`
        : `Draw mode: adjust the view angle first, then click "Draw line", then move gently and slowly over the map and click the start point and end point.${activeOverlayText}`;
  const currentModeSummary =
    viewMode === "horizontal"
      ? overlayOpacity > 0.001
        ? `Horizontal mode is showing ${horizontalModeLabel} at ${activeDepthLabel} and ${activeTimeLabel}.${activeOverlayText}`
        : `Horizontal mode is showing ${horizontalModeLabel}.${activeOverlayText}`
      : viewMode === "transect"
        ? `Zonal mode is showing a west-east section at ${latTarget.toFixed(2)}°N and ${activeTimeLabel}. Slice the latitude target to move the section north or south.${activeOverlayText}`
      : viewMode === "draw"
          ? drawMapInstruction
          : viewMode === "class"
            ? `Class mode is showing ${range.title} point-cloud classes between ${classMin} and ${classMax} at ${activeTimeLabel}.${activeOverlayText}`
            : `Eddy mode is showing eddy detections at ${activeTimeLabel}.${activeOverlayText}`;
  const timeCoverageLabel =
    timeList.length > 1 ? `${timeList[0]} to ${timeList[timeList.length - 1]}` : timeList[0] ?? "n/a";
  const depthCoverageLabel =
    zList.length > 1 ? `${Math.round(zList[0])} to ${Math.round(zList[zList.length - 1])} m` : "n/a";
  const domainLabel = `${lonMin.toFixed(1)} to ${lonMax.toFixed(1)} lon, ${latMin.toFixed(1)} to ${latMax.toFixed(1)} lat`;
  const loadErrors = [
    metaStatus === "failed" && metaError ? `Metadata: ${metaError}` : null,
    sliceStatus === "failed" && sliceError ? `Slice: ${sliceError}` : null,
    classStatus === "failed" && classError ? `Class: ${classError}` : null,
    eddyStatus === "failed" && eddyError ? `Eddies: ${eddyError}` : null,
    seaIceStatus === "failed" && seaIceError ? `Sea ice: ${seaIceError}` : null,
    windStatus === "failed" && windError ? `Wind: ${windError}` : null,
  ].filter(Boolean) as string[];

  const availableVars = useMemo(() => {
    const vars = meta?.variables?.filter((v) => v.available).map((v) => v.id) ?? [];
    return vars.length ? (vars as VarId[]) : (["T"] as VarId[]);
  }, [meta]);
  const hasTemperature = availableVars.includes("T");
  const hasSalinity = availableVars.includes("S");

  const activateScalarVariable = useCallback(
    (nextVar: VarId) => {
      if (!availableVars.includes(nextVar)) return;
      setVarId(nextVar);
      setOverlayOpacity((prev) => (prev > 0.001 ? prev : 0.9));
    },
    [availableVars]
  );

  useEffect(() => {
    if (viewMode !== "transect" && viewMode !== "draw") return;
    if (availableVars.includes("T")) {
      setVarId("T");
      setOverlayOpacity((prev) => (prev > 0.001 ? prev : 0.9));
      return;
    }
    if (availableVars.length) {
      setVarId(availableVars[0]);
      setOverlayOpacity((prev) => (prev > 0.001 ? prev : 0.9));
    }
  }, [availableVars, viewMode]);

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
    const nextMin = String(colorScaleUsesClassRange ? classSettings.min : settings.cmin);
    const nextMax = String(colorScaleUsesClassRange ? classSettings.max : settings.cmax);
    setColorInputByVar((prev) => {
      const curr = prev[varId];
      if (curr?.min === nextMin && curr?.max === nextMax) return prev;
      return {
        ...prev,
        [varId]: { min: nextMin, max: nextMax },
      };
    });
  }, [classSettings.max, classSettings.min, colorScaleUsesClassRange, settings.cmax, settings.cmin, varId]);

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
      const fallback = colorScaleUsesClassRange
        ? bound === "min"
          ? classSettings.min
          : classSettings.max
        : bound === "min"
          ? settings.cmin
          : settings.cmax;
      if (parsed != null) {
        if (colorScaleUsesClassRange) {
          setClassSettingsByVar((prev) => ({
            ...prev,
            [varId]: {
              ...prev[varId],
              [bound]: parsed,
            },
          }));
        } else {
          const colorKey = bound === "min" ? "cmin" : "cmax";
          setColorSettings((prev) => ({
            ...prev,
            [varId]: {
              ...prev[varId],
              [colorKey]: parsed,
            },
          }));
        }
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
    [
      classSettings.max,
      classSettings.min,
      colorInputByVar,
      colorScaleUsesClassRange,
      setDrawAutoColorRangeEnabled,
      settings.cmax,
      settings.cmin,
      varId,
      viewMode,
    ]
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
      if (colorScaleUsesClassRange) {
        setClassSettingsByVar((prev) => ({
          ...prev,
          [varId]: {
            ...prev[varId],
            [bound]: parsed,
          },
        }));
      } else {
        const colorKey = bound === "min" ? "cmin" : "cmax";
        setColorSettings((prev) => ({
          ...prev,
          [varId]: {
            ...prev[varId],
            [colorKey]: parsed,
          },
        }));
      }
    },
    [colorScaleUsesClassRange, setDrawAutoColorRangeEnabled, varId, viewMode]
  );

  const nudgeColorScaleBound = useCallback(
    (bound: "min" | "max", direction: 1 | -1) => {
      if (viewMode === "draw") setDrawAutoColorRangeEnabled(false);
      const currentMin = colorScaleUsesClassRange ? classSettings.min : settings.cmin;
      const currentMax = colorScaleUsesClassRange ? classSettings.max : settings.cmax;
      const next =
        bound === "min"
          ? nudgeBoundedValue(currentMin, direction, colorScaleStep, Number.NEGATIVE_INFINITY, currentMax)
          : nudgeBoundedValue(currentMax, direction, colorScaleStep, currentMin, Number.POSITIVE_INFINITY);
      if (colorScaleUsesClassRange) {
        setClassSettingsByVar((prev) => ({
          ...prev,
          [varId]: {
            ...prev[varId],
            [bound]: next,
          },
        }));
      } else {
        const colorKey = bound === "min" ? "cmin" : "cmax";
        setColorSettings((prev) => ({
          ...prev,
          [varId]: {
            ...prev[varId],
            [colorKey]: next,
          },
        }));
      }
      setColorInputByVar((prev) => ({
        ...prev,
        [varId]: {
          ...(prev[varId] ?? { min: "", max: "" }),
          [bound]: String(next),
        },
      }));
    },
    [
      classSettings.max,
      classSettings.min,
      colorScaleStep,
      colorScaleUsesClassRange,
      setDrawAutoColorRangeEnabled,
      settings.cmax,
      settings.cmin,
      varId,
      viewMode,
    ]
  );

  const nudgeTickCount = useCallback(
    (direction: 1 | -1) => {
      const nextIndex = clamp(safeTickCountIndex + direction, 0, tickCountOptions.length - 1);
      const next = tickCountOptions[nextIndex];
      setColorSettings((prev) => ({
        ...prev,
        [varId]: { ...prev[varId], tickCount: next },
      }));
    },
    [safeTickCountIndex, tickCountOptions, varId]
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
  const showPlotlyPerformanceHint = viewMode === "transect" || viewMode === "draw" || viewMode === "class";
  const drawTransectHint =
    !drawTransectArmed && drawTransectPoints.length < 2
      ? 'Draw mode is idle. Adjust the view angle first, then click "Draw line".'
      : drawTransectArmed && drawTransectPoints.length === 0
        ? 'Move gently and slowly over the map, then click the transect start point.'
      : drawTransectArmed && drawTransectPoints.length === 1
          ? "Move gently and slowly over the map to preview the line, then click the transect end point."
          : drawTransectPoints.length >= 2
            ? `Transect length: ${drawTransectLengthKm.toFixed(0)} km. Click "Clear" to remove it, then adjust the angle and click "Draw line" to start again.`
            : "Draw a line to extract an arbitrary transect.";

  useEffect(() => {
    if (viewMode !== "draw") {
      setDrawTransectArmed(false);
      setDrawTransectHoverPoint(null);
    }
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
  const scalarFieldVisible = overlayOpacity > 0.001;

  const horizontalField = useMemo(() => {
    if (!meta || !projectOn3d || !horizontalRender) return undefined;
    if (viewMode !== "horizontal" && viewMode !== "draw") return undefined;
    if (!scalarFieldVisible) return undefined;
    if (drawTransectComplete) return undefined;
    const dataColorbarTitle = varId === "T" ? "Modeled Temperature (°C)" : range.title;
    const dataColorbarTickText = colorbarTicks ? formatColorbarTickText(colorbarTicks, dataColorbarTitle) : undefined;
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
      colorbarTitle: dataColorbarTitle,
      colorbarTicks,
      colorbarTickText: dataColorbarTickText,
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
    scalarFieldVisible,
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
    if (!scalarFieldVisible) return undefined;
    const cmin = drawAutoColorRangeActive && drawTransectAutoRange ? drawTransectAutoRange.min : settings.cmin;
    const cmax = drawAutoColorRangeActive && drawTransectAutoRange ? drawTransectAutoRange.max : settings.cmax;
    const transectColorbarTicks =
      drawAutoColorRangeActive && drawTransectAutoRange && settings.tickCount > 0
        ? makeTicks(drawTransectAutoRange.min, drawTransectAutoRange.max, settings.tickCount)
        : colorbarTicks;
    const dataColorbarTitle = varId === "T" ? "Modeled Temperature (°C)" : range.title;
    const dataColorbarTickText = transectColorbarTicks
      ? formatColorbarTickText(transectColorbarTicks, dataColorbarTitle)
      : undefined;
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
      colorbarTitle: dataColorbarTitle,
      colorbarTicks: transectColorbarTicks,
      colorbarTickText: dataColorbarTickText,
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
    scalarFieldVisible,
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
    const seaIceTicks = [cmin, 0.5, 0.75, 1].filter((v, i, arr) => arr.indexOf(v) === i);
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
      colorbarTicks: seaIceTicks,
      colorbarTickText: formatColorbarTickText(seaIceTicks, "Sea ice concentration"),
      colorbarLen: seaIceColorbarLayout.len,
      colorbarX: seaIceColorbarLayout.x,
      colorbarY: seaIceColorbarLayout.y,
      colorbarTitle: "Sea ice concentration",
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

  const windParticleCount = useMemo(() => {
    const area = Math.max(1, viewportWidth * viewportHeight);
    const referenceArea = 1280 * 720;
    const baseCount = playing ? 900 : 1350;
    const scaled = Math.round((baseCount * area) / referenceArea);
    return clamp(scaled, playing ? 700 : 950, playing ? 1800 : 2400);
  }, [playing, viewportHeight, viewportWidth]);

  const windLayer = useMemo(() => {
    if (!meta || !projectOn3d || !showWind || !windRender) return undefined;
    return {
      enabled: true,
      lon: windRender.lon,
      lat: windRender.lat,
      u: windRender.u,
      v: windRender.v,
      zPlane: SEA_ICE_HEIGHT_M + 12,
      particleCount: windParticleCount,
      speed: 2.6,
      color: "rgba(255,255,255,0.90)",
      size: playing ? 1.1 : 1.35,
    };
  }, [meta, projectOn3d, showWind, windParticleCount, windRender, playing]);

  const classLayer = useMemo(() => {
    if (!meta || !projectOn3d || viewMode !== "class" || !classTraces?.length) return undefined;
    const classValues = classTraces.map((t) => t.value).sort((a, b) => a - b);
    const ticks = pickClassTicks(classValues, 12);
    const tickText = ticks.map((v) => formatClassLabel(varId, v, classInterval, false));
    const classLabel = varId === "T" ? "Modeled Temperature" : range.title;
    return {
      enabled: true,
      varLabel: classLabel,
      points: classTraces,
      markerSize: playing ? 2.2 : 2.8,
      opacity: 0.7,
      showLegend: true,
      cmin: classMin,
      cmax: classMax,
      colorscale: makeClassDiscreteColorscale(classValues, classMin, classMax, fieldPalette),
      showScale: showColorbarActive,
      colorbarTitle: `${classLabel} class`,
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
  const showBathyColorbar =
    showColorbarActive &&
    showBathy &&
    !showHorizontalColorbar &&
    !(transectField?.showScale ?? false) &&
    !(classLayer?.showScale ?? false);
  const showBathyColorbarThree = showColorbarActive && showBathy;
  const bathyColorbarTitle = "Topography";
  const bathyColorbarSubtitle =
    bathySource === "rtopo"
      ? "30 arcseconds RTopo-2.0.4 bed elevation (m)"
      : "MITgcm model grid";

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
    if (viewMode === "class") {
      setClassSettingsByVar((prev) => ({
        ...prev,
        [varId]: {
          ...prev[varId],
          min: DEFAULT_CLASS_SETTINGS[varId].min,
          max: DEFAULT_CLASS_SETTINGS[varId].max,
        },
      }));
    }
    setColorSettings((prev) => ({ ...prev, [varId]: DEFAULT_COLOR_SETTINGS[varId] }));
    setFieldColormapByVar((prev) => ({ ...prev, [varId]: DEFAULT_FIELD_COLORMAP[varId] }));
  }, [setDrawAutoColorRangeEnabled, varId, viewMode]);

  const resetCamera = useCallback(() => {
    try {
      window.localStorage.removeItem("gs_scene_camera_v1");
      window.localStorage.removeItem("gs_scene_camera_three_v1");
    } catch {
      // ignore
    }
    setCameraResetNonce((n) => n + 1);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      void document.documentElement.requestFullscreen?.();
    }
  }, []);

  const startPanelResize = useCallback(
    (corner: PanelResizeCorner, e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startWidth = rect.width;
      const startHeight = rect.height;
      const startLeft = panelPos?.left ?? rect.left;
      const startTop = panelPos?.top ?? rect.top;
      const isWest = corner === "nw" || corner === "sw";
      const isNorth = corner === "nw" || corner === "ne";

      const onMove = (ev: PointerEvent) => {
        const rawWidth = startWidth + (corner === "ne" || corner === "se" ? ev.clientX - startX : startX - ev.clientX);
        const rawHeight =
          startHeight + (corner === "sw" || corner === "se" ? ev.clientY - startY : startY - ev.clientY);
        const nextSize = clampPanelSize(
          { width: rawWidth, height: rawHeight },
          viewportWidth,
          viewportHeight,
          isMobileViewport
        );
        const maxLeft = Math.max(12, viewportWidth - nextSize.width - 12);
        const maxTop = Math.max(12, viewportHeight - nextSize.height - 12);
        const nextLeft = isWest ? startLeft + (startWidth - nextSize.width) : startLeft;
        const nextTop = isNorth ? startTop + (startHeight - nextSize.height) : startTop;
        setPanelSize(nextSize);
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
    },
    [isMobileViewport, panelPos?.left, panelPos?.top, viewportHeight, viewportWidth]
  );

  const autoColorScaleFromFrame = useCallback(() => {
    if (viewMode === "draw") setDrawAutoColorRangeEnabled(false);
    const values =
      viewMode === "horizontal" || viewMode === "class" || (viewMode === "draw" && !transectValuesMasked)
        ? horizontalValuesMasked
        : transectValuesMasked;
    if (!values) return;
    const mm = computeMinMax(values, { ignoreExactZero: varId === "S" });
    if (!mm) return;
    if (viewMode === "class") {
      setClassSettingsByVar((prev) => ({
        ...prev,
        [varId]: {
          ...prev[varId],
          min: Number(mm.min.toFixed(3)),
          max: Number(mm.max.toFixed(3)),
        },
      }));
      return;
    }
    setColorSettings((prev) => ({
      ...prev,
      [varId]: {
        ...prev[varId],
        cmin: Number(mm.min.toFixed(3)),
        cmax: Number(mm.max.toFixed(3)),
      },
    }));
  }, [horizontalValuesMasked, setDrawAutoColorRangeEnabled, transectValuesMasked, varId, viewMode]);

  const effectiveRenderer3d: Renderer3D = viewMode === "horizontal" ? "three" : "plotly";

  return (
    <div className="app">
      {effectiveRenderer3d === "three" ? (
        <BasemapThree
          bathySource={bathySource}
          bathyPalette={bathyPalette}
          bathyOpacity={drawTransectComplete ? 0.22 : 1}
          bathyColorbar={{
            enabled: showBathyColorbarThree,
            title: bathyColorbarTitle,
            subtitle: bathyColorbarSubtitle,
            len: mainColorbarLayout.len,
            x: mainColorbarLayout.x,
            y: mainColorbarLayout.y,
          }}
          compactLayout={isMobileViewport}
          cameraAutoFitKey={threeCameraAutoFitKey}
          cameraResetNonce={cameraResetNonce}
          depthRatio={deferredDepthRatio}
          fitReservedLeftPx={panelReservedLeftPx}
          themeMode={themeMode}
          showBathy={showBathy}
          onStatusChange={handleStatusChange}
          horizontalField={horizontalField}
          horizontalPlanes={horizontalPlanes}
          windLayer={windLayer}
          guidePath={drawGuidePath}
          drawingMode={viewMode === "draw" && drawTransectArmed}
          onSurfacePick={handleDrawSurfacePick}
          onSurfaceHover={handleDrawSurfaceHover}
          viewerHint={currentModeSummary}
        />
      ) : (
        <Basemap3D
          bathySource={bathySource}
          bathyPalette={bathyPalette}
          bathyOpacity={drawTransectComplete ? 0.22 : 1}
          bathyColorbar={{
            enabled: showBathyColorbar,
            title: bathyColorbarTitle,
            subtitle: bathyColorbarSubtitle,
            len: mainColorbarLayout.len,
            x: mainColorbarLayout.x,
            y: mainColorbarLayout.y,
          }}
          compactLayout={isMobileViewport}
          cameraFocusPath={drawCameraFocusPath}
          cameraResetNonce={cameraResetNonce}
          depthRatio={deferredDepthRatio}
          depthWarp={{ mode: depthWarpMode, focusDepthM: depthFocusM, deepRatio }}
          themeMode={themeMode}
          showBathy={showBathy}
          onStatusChange={handleStatusChange}
          horizontalField={horizontalField}
          horizontalPlanes={horizontalPlanes}
          guidePath={drawGuidePath}
          windLayer={windLayer}
          classLayer={classLayer}
          eddyLayer={eddyLayer}
          transectField={transectField}
          cameraPreset={
            viewMode !== "horizontal"
              ? {
                  nonce: plotlyCameraNonce,
                  camera: viewMode === "transect" ? ZONAL_OVERVIEW_CAMERA : PLOTLY_OVERVIEW_CAMERA,
                }
              : undefined
          }
          drawingMode={viewMode === "draw" && drawTransectArmed}
          onSurfacePick={handleDrawSurfacePick}
          onSurfaceHover={handleDrawSurfaceHover}
          viewerHint={currentModeSummary}
        />
      )}

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
            className="panel controlPanel iosSettingsPanel"
            style={{
              left: panelPos?.left ?? (isMobileViewport ? 12 : 16),
              width: panelBoxSize.width,
              height: panelDisplayHeight,
              ...(isFullscreen && !isMobileViewport
                ? { top: 16 }
                : panelPos
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
                e.preventDefault();
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
                  title="Default northward/meridional view"
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
                <button
                  type="button"
                  className="panelIconButton"
                  title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                  onClick={toggleFullscreen}
                >
                  {isFullscreen ? "⤡" : "⤢"}
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

            <div
              className="panelResizeHandle panelResizeHandleNW"
              title="Resize panel"
              onPointerDown={(e) => startPanelResize("nw", e)}
            />
            <div
              className="panelResizeHandle panelResizeHandleNE"
              title="Resize panel"
              onPointerDown={(e) => startPanelResize("ne", e)}
            />
            <div
              className="panelResizeHandle panelResizeHandleSW"
              title="Resize panel"
              onPointerDown={(e) => startPanelResize("sw", e)}
            />
            <div
              className="panelResizeHandle panelResizeHandleSE"
              title="Resize panel"
              onPointerDown={(e) => startPanelResize("se", e)}
            />
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
                  <div className="sectionSubheadRow">
                    <span className="sectionGlyph sectionGlyphMode" aria-hidden>◫</span>
                    <div className="sectionSubhead">View mode</div>
                  </div>
                  <div className="tabs tabs4">
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
                          {drawTransectArmed ? "Click the map..." : "Draw line"}
                        </button>
                        <button
                          type="button"
                          className="tab"
                          style={{ flex: 1 }}
                          disabled={metaStatus !== "ready"}
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
                  <div className="hint">{viewModeDescription}</div>
                  {showPlotlyPerformanceHint ? (
                    <div className="hint">Plotly rendering may be slow in this mode.</div>
                  ) : null}

                  <div className="sectionSubheadRow">
                    <span className="sectionGlyph sectionGlyphTopo" aria-hidden>⌂</span>
                    <div className="sectionSubhead">Topography</div>
                  </div>
                  <label>
                    Topography source
                    <select value={bathySource} onChange={(e) => setBathySource(e.target.value as BathySourceId)}>
                      {BATHY_SOURCE_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <div className="hint">
                      {BATHY_SOURCE_OPTIONS.find((opt) => opt.id === bathySource)?.hint ??
                        "Choose the terrain source."}
                    </div>
                  </label>

                  <label>
                    Topography colormap
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

                  <label>
                    Vertical scaling ({depthRatio.toFixed(2)}x)
                    <RangeNudgeSlider
                      min={0.15}
                      max={1.5}
                      step={0.05}
                      value={depthRatio}
                      onChange={(next) => {
                        startDepthScaleTransition(() => {
                          setDepthRatio(next);
                        });
                      }}
                    />
                    <div className="hint">
                      {isDepthScalePending
                        ? "Updating 3D scale..."
                        : "Higher values emphasize ridges, shelves, and basin walls."}
                    </div>
                  </label>
                  <div className="toggleRow">
                    <div>Topography</div>
                    <ToggleSwitch checked={showBathy} onCheckedChange={setShowBathy} />
                  </div>

                  <div className="sectionSubheadRow">
                    <span className="sectionGlyph sectionGlyphVars" aria-hidden>∑</span>
                    <div className="sectionSubhead">Variables</div>
                  </div>
                  <div className="toggleGrid2">
                    <div className="toggleRow">
                      <div>Temperature</div>
                      <ToggleSwitch
                        checked={scalarFieldVisible && varId === "T"}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            activateScalarVariable("T");
                          } else if (varId === "T") {
                            setOverlayOpacity(0);
                          }
                        }}
                        disabled={!hasTemperature}
                      />
                    </div>
                    <div className="toggleRow">
                    <div>Salinity</div>
                      <ToggleSwitch
                        checked={scalarFieldVisible && varId === "S"}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            activateScalarVariable("S");
                          } else if (varId === "S") {
                            setOverlayOpacity(0);
                          }
                        }}
                        disabled={!hasSalinity}
                      />
                    </div>
                    <div className="toggleRow">
                      <div>Wind stress</div>
                      <ToggleSwitch checked={showWind} onCheckedChange={setShowWind} />
                    </div>
                    <div className="toggleRow">
                      <div>Sea ice</div>
                      <ToggleSwitch checked={showSeaIce} onCheckedChange={setShowSeaIce} />
                    </div>
                  </div>
                  <label>
                    Field opacity
                    <select
                      className="selectCompact"
                      value={String(overlayOpacity)}
                      onChange={(e) => setOverlayOpacity(Number(e.target.value))}
                      disabled={!projectOn3d}
                    >
                      <option value="0">0.00</option>
                      <option value="0.65">0.65</option>
                      <option value="0.75">0.75</option>
                      <option value="0.85">0.85</option>
                      <option value="0.9">0.90</option>
                      <option value="0.95">0.95</option>
                      <option value="1">1.00</option>
                    </select>
                  </label>
                  <div className="hint">
                    Temperature and Modeled Salinity share one scalar layer; turning one on switches the other off.
                  </div>

                  <div className="sectionSubheadRow">
                    <span className="sectionGlyph sectionGlyphColor" aria-hidden>◐</span>
                    <div className="sectionSubhead">Color scale</div>
                  </div>
                  {viewMode === "eddies" ? (
                    <div className="hint">
                      Eddy mode uses fixed warm/cold anomaly colors. Variable choice still controls the detector.
                    </div>
                  ) : null}
                  <label>
                    {varId === "T" ? "Temperature colormap" : "Modeled Salinity colormap"}
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
                      <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
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
                          style={{ flex: 1 }}
                        />
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <button
                            type="button"
                            className="tab"
                            style={{ minWidth: 28, padding: "2px 8px", lineHeight: 1, fontWeight: 700 }}
                            disabled={drawAutoColorRangeActive}
                            onClick={() => nudgeColorScaleBound("min", 1)}
                            aria-label="Increase minimum"
                            title="Increase"
                          >
                            ^
                          </button>
                          <button
                            type="button"
                            className="tab"
                            style={{ minWidth: 28, padding: "2px 8px", lineHeight: 1, fontWeight: 700 }}
                            disabled={drawAutoColorRangeActive}
                            onClick={() => nudgeColorScaleBound("min", -1)}
                            aria-label="Decrease minimum"
                            title="Decrease"
                          >
                            v
                          </button>
                        </div>
                      </div>
                    </label>
                    <label style={{ flex: 1 }}>
                      Max
                      <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
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
                          style={{ flex: 1 }}
                        />
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <button
                            type="button"
                            className="tab"
                            style={{ minWidth: 28, padding: "2px 8px", lineHeight: 1, fontWeight: 700 }}
                            disabled={drawAutoColorRangeActive}
                            onClick={() => nudgeColorScaleBound("max", 1)}
                            aria-label="Increase maximum"
                            title="Increase"
                          >
                            ^
                          </button>
                          <button
                            type="button"
                            className="tab"
                            style={{ minWidth: 28, padding: "2px 8px", lineHeight: 1, fontWeight: 700 }}
                            disabled={drawAutoColorRangeActive}
                            onClick={() => nudgeColorScaleBound("max", -1)}
                            aria-label="Decrease maximum"
                            title="Decrease"
                          >
                            v
                          </button>
                        </div>
                      </div>
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
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button
                          type="button"
                          className="tab"
                          style={{ minWidth: 28, padding: "2px 8px", lineHeight: 1, fontWeight: 700 }}
                          disabled={safeTickCountIndex <= 0}
                          onClick={() => nudgeTickCount(-1)}
                          aria-label="Previous tick count"
                          title="Previous"
                        >
                          &lt;
                        </button>
                        <select
                          value={String(settings.tickCount)}
                          onChange={(e) =>
                            setColorSettings((prev) => ({
                              ...prev,
                              [varId]: { ...prev[varId], tickCount: Number(e.target.value) },
                            }))
                          }
                          style={{ flex: 1 }}
                        >
                          <option value="0">Auto</option>
                          {TICK_OPTIONS_BY_VAR[varId].map((count) => (
                            <option key={count} value={String(count)}>
                              {count}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="tab"
                          style={{ minWidth: 28, padding: "2px 8px", lineHeight: 1, fontWeight: 700 }}
                          disabled={safeTickCountIndex >= tickCountOptions.length - 1}
                          onClick={() => nudgeTickCount(1)}
                          aria-label="Next tick count"
                          title="Next"
                        >
                          &gt;
                        </button>
                      </div>
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
                    Default: <b>[
                      {viewMode === "class" ? DEFAULT_CLASS_SETTINGS[varId].min : DEFAULT_COLOR_SETTINGS[varId].cmin},
                      {" "}
                      {viewMode === "class" ? DEFAULT_CLASS_SETTINGS[varId].max : DEFAULT_COLOR_SETTINGS[varId].cmax}
                    ]</b>
                  </div>

                  <div className="sectionSubheadRow">
                    <span className="sectionGlyph sectionGlyphTempo" aria-hidden>◷</span>
                    <div className="sectionSubhead">Tempo-spatial</div>
                  </div>
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
                    <RangeNudgeSlider
                      min={0}
                      max={Math.max(0, timeList.length - 1)}
                      value={safeTimeIdx}
                      onChange={setTimeIdx}
                      disabled={metaStatus !== "ready" || !timeList.length}
                      buttonLayout="horizontal"
                      decreaseLabel="<"
                      increaseLabel=">"
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

                  {viewMode === "horizontal" || viewMode === "draw" ? (
                    <>
                      <label>
                        Depth ({activeDepthLabel})
                        <RangeNudgeSlider
                          min={0}
                          max={Math.max(0, zList.length - 1)}
                          value={safeDepthIdx}
                          onChange={setDepthIdx}
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
                    </>
                  ) : viewMode === "transect" ? (
                    <label>
                      Latitude target (°N) ({latTarget.toFixed(2)}°N)
                      <RangeNudgeSlider
                        min={latMin}
                        max={latMax}
                        step={TRANSECT_SLICE_STEP_DEG}
                        value={latTarget}
                        onChange={setLatTarget}
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
                      <div className="hint">Slice the latitude target to move the zonal section north or south.</div>
                      <div style={{ display: "flex", alignItems: "stretch", gap: 8, marginTop: 8 }}>
                        <input
                          type="number"
                          value={latTargetInput}
                          min={latMin}
                          max={latMax}
                          step={TRANSECT_SLICE_STEP_DEG}
                          onChange={(e) => setLatTargetInput(e.target.value)}
                          onBlur={commitLatTargetInput}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitLatTargetInput();
                          }}
                          disabled={metaStatus !== "ready"}
                          style={{ flex: 1 }}
                        />
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <button
                            type="button"
                            className="tab"
                            style={{ minWidth: 28, padding: "2px 8px", lineHeight: 1, fontWeight: 700 }}
                            disabled={metaStatus !== "ready" || latTarget >= latMax}
                            onClick={() => {
                              const next = nudgeRangeValue(
                                latTarget,
                                1,
                                latMin,
                                latMax,
                                TRANSECT_SLICE_STEP_DEG
                              );
                              setLatTarget(next);
                              setLatTargetInput(String(Number(next.toFixed(3))));
                            }}
                            aria-label="Increase latitude target"
                            title="Increase"
                          >
                            ^
                          </button>
                          <button
                            type="button"
                            className="tab"
                            style={{ minWidth: 28, padding: "2px 8px", lineHeight: 1, fontWeight: 700 }}
                            disabled={metaStatus !== "ready" || latTarget <= latMin}
                            onClick={() => {
                              const next = nudgeRangeValue(
                                latTarget,
                                -1,
                                latMin,
                                latMax,
                                TRANSECT_SLICE_STEP_DEG
                              );
                              setLatTarget(next);
                              setLatTargetInput(String(Number(next.toFixed(3))));
                            }}
                            aria-label="Decrease latitude target"
                            title="Decrease"
                          >
                            v
                          </button>
                        </div>
                      </div>
                      {transectLatActual != null ? (
                        <div className="hint">Nearest model latitude: {transectLatActual.toFixed(3)}°N</div>
                      ) : null}
                    </label>
                  ) : null}
                  <div className="sectionSubheadRow">
                    <span className="sectionGlyph sectionGlyphMask" aria-hidden>◍</span>
                    <div className="sectionSubhead">Masks</div>
                  </div>
                  <div className="toggleGrid2">
                    <div className="toggleRow">
                      <div>North Atlantic</div>
                      <ToggleSwitch checked={showGsrMask} onCheckedChange={setShowGsrMask} />
                    </div>
                    <div className="toggleRow">
                      <div>Greenland Sea</div>
                      <ToggleSwitch checked={showGreenlandSeaMask} onCheckedChange={setShowGreenlandSeaMask} />
                    </div>
                    <div className="toggleRow">
                      <div>Iceland Sea</div>
                      <ToggleSwitch checked={showIcelandSeaMask} onCheckedChange={setShowIcelandSeaMask} />
                    </div>
                    <div className="toggleRow">
                      <div>Norwegian Sea</div>
                      <ToggleSwitch checked={showNorwegianSeaMask} onCheckedChange={setShowNorwegianSeaMask} />
                    </div>
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

                  {viewMode === "class" ? (
                    <>
                      <div className="sectionSubheadRow">
                        <span className="sectionGlyph sectionGlyphClass" aria-hidden>⌗</span>
                        <div className="sectionSubhead">Class settings</div>
                      </div>
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
                        <RangeNudgeSlider
                          min={CLASS_DENSITY_MIN}
                          max={CLASS_DENSITY_MAX}
                          step={CLASS_DENSITY_STEP}
                          value={clampClassDensity(classDensity)}
                          onChange={(next) => setClassDensity(clampClassDensity(next))}
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
                  ) : null}
                </div>
              </details>

              <details className="section" open>
                <summary>Data Snapshot</summary>
                <div className="sectionBody">
                  <div className="infoGrid">
                    <div className="infoCard">
                      <div className="infoLabel">Dataset</div>
                      <div className="infoValue">
                        {meta?.storeUrl ? meta.storeUrl.split("/").slice(-1)[0] : "public/data/nordic.zarr"}
                      </div>
                      <div className="infoMeta">Meta {metaStatus}</div>
                    </div>
                    <div className="infoCard">
                      <div className="infoLabel">3D runtime</div>
                      <div className="infoValue">{effectiveRenderer3d}: {bathyInfo.plotly}</div>
                      <div className="infoMeta">Bathy {bathyInfo.bathy}</div>
                    </div>
                    <div className="infoCard">
                      <div className="infoLabel">Slice</div>
                      <div className="infoValue">{sliceStatus}</div>
                      <div className="infoMeta">
                        {viewMode === "draw"
                          ? drawTransectPoints.length >= 2
                            ? `${drawTransectLengthKm.toFixed(0)} km line`
                            : drawTransectArmed
                              ? "awaiting clicks"
                              : "no line"
                          : activeDepthLabel}
                      </div>
                    </div>
                    <div className="infoCard">
                      <div className="infoLabel">Overlays</div>
                      <div className="infoValue">
                        {showWind ? `Wind ${windStatus}` : showSeaIce ? `Ice ${seaIceStatus}` : "No extra layer"}
                      </div>
                      <div className="infoMeta">
                        Horizontal {bathyInfo.horizontalImage}, transect {bathyInfo.transectImage}
                      </div>
                    </div>
                  </div>

                  <div className="sectionSubheadRow">
                    <span className="sectionGlyph sectionGlyphData" aria-hidden>◨</span>
                    <div className="sectionSubhead">Data and coverage</div>
                  </div>
                  <div className="hint">Time coverage: <b>{timeCoverageLabel}</b></div>
                  <div className="hint">Vertical range: <b>{depthCoverageLabel}</b> across <b>{zList.length || 0}</b> levels.</div>
                  <div className="hint">Domain: <b>{domainLabel}</b></div>
                  <div className="hint">
                    Masks:{" "}
                    <b>
                      {[
                        showGsrMask ? "North Atlantic" : null,
                        showGreenlandSeaMask ? "Greenland Sea" : null,
                        showIcelandSeaMask ? "Iceland Sea" : null,
                        showNorwegianSeaMask ? "Norwegian Sea" : null,
                      ]
                        .filter(Boolean)
                        .join(", ") || "none"}
                    </b>
                  </div>

                  <div className="sectionSubheadRow">
                    <span className="sectionGlyph sectionGlyphErr" aria-hidden>!</span>
                    <div className="sectionSubhead">Errors</div>
                  </div>
                  {loadErrors.length ? (
                    loadErrors.map((message) => (
                      <div key={message} className="hint">
                        {message}
                      </div>
                    ))
                  ) : (
                    <div className="hint">No current load errors.</div>
                  )}
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
                    <div style={{ fontSize: 12, color: feedbackLabelColor }}>Feedback:</div>
                    <a
                      href="https://bve23zsu.github.io/"
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Webpage"
                      title="Webpage"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        color: feedbackLinkColor,
                        textDecoration: "none",
                        fontSize: 12,
                        opacity: 0.9,
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm6.93 9h-3.16a15.7 15.7 0 00-1.38-5.03A8.03 8.03 0 0118.93 11zM12 4.04c.86 1.16 1.78 3.27 2.15 6.96H9.85C10.22 7.31 11.14 5.2 12 4.04zM4.07 13h3.16c.14 1.86.6 3.62 1.38 5.03A8.03 8.03 0 014.07 13zm3.16-2H4.07a8.03 8.03 0 014.54-5.03A15.7 15.7 0 007.23 11zM12 19.96c-.86-1.16-1.78-3.27-2.15-6.96h4.31c-.37 3.69-1.29 5.8-2.16 6.96zM14.77 13h3.16a8.03 8.03 0 01-4.54 5.03c.78-1.41 1.24-3.17 1.38-5.03z" />
                      </svg>
                    </a>
                    <a
                      href="https://github.com/nordicseas3d/nordicseas3d.github.io"
                      target="_blank"
                      rel="noreferrer"
                      aria-label="GitHub"
                      title="GitHub"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        color: feedbackLinkColor,
                        textDecoration: "none",
                        fontSize: 12,
                        opacity: 0.9,
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.21.68-.48v-1.68c-2.78.6-3.37-1.18-3.37-1.18-.46-1.15-1.11-1.46-1.11-1.46-.91-.61.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.64.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0112 6.84c.85 0 1.71.11 2.51.33 1.91-1.3 2.75-1.03 2.75-1.03.55 1.37.2 2.39.1 2.64.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.86v2.76c0 .27.18.57.69.47A10 10 0 0012 2z" />
                      </svg>
                    </a>
                    <a
                      href="https://nordicseas.github.io/"
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Twin website"
                      title="Twin website"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        color: feedbackLinkColor,
                        textDecoration: "none",
                        fontSize: 12,
                        opacity: 0.9,
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm6.93 9h-3.16a15.7 15.7 0 00-1.38-5.03A8.03 8.03 0 0118.93 11zM12 4.04c.86 1.16 1.78 3.27 2.15 6.96H9.85C10.22 7.31 11.14 5.2 12 4.04zM4.07 13h3.16c.14 1.86.6 3.62 1.38 5.03A8.03 8.03 0 014.07 13zm3.16-2H4.07a8.03 8.03 0 014.54-5.03A15.7 15.7 0 007.23 11zM12 19.96c-.86-1.16-1.78-3.27-2.15-6.96h4.31c-.37 3.69-1.29 5.8-2.16 6.96zM14.77 13h3.16a8.03 8.03 0 01-4.54 5.03c.78-1.41 1.24-3.17 1.38-5.03z" />
                      </svg>
                      <span>Twin site</span>
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
