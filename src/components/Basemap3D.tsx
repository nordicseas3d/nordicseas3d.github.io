import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, PlotData } from "plotly.js";
import { withBase } from "../lib/paths";
import { makeSyntheticGreenlandSeaBathy } from "../lib/syntheticBathy";
import {
  deep_256,
  paletteToColorscale,
  rdylbu_r_256,
  rgbKey,
  topo_256,
  type RGB,
} from "../lib/colormap";
import {
  getPixelRGBA,
  loadImageData,
  makeDiscreteColorscale332,
  rgbToIndex332,
} from "../lib/imageSampling";

type BathyGrid = {
  lon: number[];
  lat: number[];
  z: number[][];
  zRaw?: number[][]; // signed: land positive, ocean negative (when available)
};

type LonLatBounds = {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
};

type LonDepthBounds = {
  lonMin: number;
  lonMax: number;
  depthMin: number;
  depthMax: number;
};

type HorizontalField = {
  enabled: boolean;
  // values are on a (lat x lon) grid. If the grid differs from the bathymetry grid,
  // provide lon/lat for resampling onto the bathy surface.
  values: number[][];
  lon?: number[];
  lat?: number[];
  cmin: number;
  cmax: number;
  colorscale: Array<[number, string]>;
  opacity?: number;
  mode?: "surface" | "bathy";
  // Used when mode === "surface": draws the overlay as a horizontal plane at this z (meters).
  // If omitted, defaults to 0 (sea surface).
  zPlane?: number;
  showScale?: boolean;
  colorbarTitle?: string;
  colorbarTicks?: number[];
  colorbarLen?: number;
  colorbarX?: number;
  colorbarY?: number;
  hoverSkip?: boolean;
  bounds?: LonLatBounds;
  // Treat exact zero as missing (useful for some salinity exports with 0 fill over land).
  zeroAsMissing?: boolean;
  // Mask cells where nearest bathymetry is dry/land (depth near sea level).
  maskDryByBathy?: boolean;
};

type TransectField = {
  enabled: boolean;
  lat: number | number[];
  lon: number[];
  distanceKm?: number[];
  z: number[]; // negative down (meters)
  values: number[][];
  cmin: number;
  cmax: number;
  colorscale: Array<[number, string]>;
  opacity?: number;
  showScale?: boolean;
  colorbarTitle?: string;
  colorbarTicks?: number[];
  colorbarLen?: number;
  colorbarX?: number;
  colorbarY?: number;
};

type GuidePath = {
  enabled: boolean;
  lon: number[];
  lat: number[];
  zPlane?: number;
  color?: string;
  width?: number;
  markerSize?: number;
  opacity?: number;
  name?: string;
};

type WindLayer = {
  enabled: boolean;
  lon: number[];
  lat: number[];
  u: number[][];
  v: number[][];
  zPlane?: number;
  particleCount?: number;
  speed?: number;
  color?: string;
  size?: number;
};

type ClassPointTrace = {
  label: string;
  value: number;
  x: number[];
  y: number[];
  z: number[];
};

type ClassLayer = {
  enabled: boolean;
  varLabel?: string;
  points: ClassPointTrace[];
  markerSize?: number;
  opacity?: number;
  showLegend?: boolean;
  cmin: number;
  cmax: number;
  colorscale: Array<[number, string]>;
  showScale?: boolean;
  colorbarTitle?: string;
  colorbarTicks?: number[];
  colorbarTickText?: string[];
  colorbarLen?: number;
  colorbarX?: number;
  colorbarY?: number;
};

type EddyClusterTrace = {
  id: string;
  kind: "warm" | "cold";
  x: number[];
  y: number[];
  z: number[];
  trackX?: number[];
  trackY?: number[];
  trackZ?: number[];
  hoverText: string;
};

type EddyLayer = {
  enabled: boolean;
  clusters: EddyClusterTrace[];
  markerSize?: number;
  opacity?: number;
  trackOpacity?: number;
  showLegend?: boolean;
};

type WindParticle = {
  x: number;
  y: number;
  ttl: number;
  speedMag: number;
  trailX: number[];
  trailY: number[];
  trailMag: number[];
};

function makeColorbarConfig(opts: {
  title: string;
  len?: number;
  x?: number;
  y?: number;
  tickvals?: number[];
  ticktext?: string[];
}) {
  return {
    title: {
      text: opts.title,
      side: "right",
      font: { size: 14 },
    },
    ...(opts.tickvals ? { tickmode: "array", tickvals: opts.tickvals } : null),
    ...(opts.ticktext?.length ? { ticktext: opts.ticktext } : null),
    ticks: "outside",
    tickfont: { size: 12 },
    thickness: 20,
    thicknessmode: "pixels",
    outlinewidth: 1,
    outlinecolor: "rgba(255,255,255,0.35)",
    len: opts.len ?? 0.62,
    ...(Number.isFinite(opts.x) ? { x: opts.x } : null),
    ...(Number.isFinite(opts.y) ? { y: opts.y } : null),
  } as any;
}

function colorFromColorscale(
  value: number,
  cmin: number,
  cmax: number,
  colorscale: Array<[number, string]>
) {
  if (!Number.isFinite(value) || !Number.isFinite(cmin) || !Number.isFinite(cmax) || cmax <= cmin) {
    return "rgba(255,255,255,0.9)";
  }
  if (!Array.isArray(colorscale) || colorscale.length === 0) return "rgba(255,255,255,0.9)";
  const t = Math.max(0, Math.min(1, (value - cmin) / (cmax - cmin)));
  let picked = colorscale[0][1];
  for (let i = 0; i < colorscale.length; i++) {
    const stop = Number(colorscale[i][0]);
    if (!Number.isFinite(stop)) continue;
    if (t + 1e-9 >= stop) picked = colorscale[i][1];
    else break;
  }
  return picked;
}

function parsePossiblyNonStandardJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some Python JSON exports contain bare NaN/Infinity tokens.
    // Normalize those to null so the payload can still be read.
    const normalized = text
      .replace(/\bNaN\b/g, "null")
      .replace(/\b-Infinity\b/g, "null")
      .replace(/\bInfinity\b/g, "null");
    return JSON.parse(normalized) as T;
  }
}

async function tryLoadBathyJson(
  bathySource?: "auto" | "bathy" | "rtopo_ds" | "rtopo"
): Promise<BathyGrid | null> {
  try {
    const forceFull =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("bathy") === "rtopo";

    const paths = {
      nordic: withBase("data/nordic.json"),
      greenlandsea: withBase("data/greenlandsea.json"),
      bathy: withBase("data/bathy.json"),
      rtopoDs: withBase("data/bathy_RTopo_ds.json"),
      rtopo: withBase("data/bathy_RTopo.json"),
    } as const;

    const effective = forceFull ? "rtopo" : (bathySource ?? "auto");
    const candidates = (() => {
      if (effective === "bathy") return [paths.nordic, paths.greenlandsea, paths.bathy, paths.rtopoDs, paths.rtopo];
      if (effective === "rtopo_ds") return [paths.nordic, paths.rtopoDs, paths.greenlandsea, paths.bathy, paths.rtopo];
      if (effective === "rtopo") return [paths.nordic, paths.rtopo, paths.rtopoDs, paths.greenlandsea, paths.bathy];
      return [paths.nordic, paths.greenlandsea, paths.bathy, paths.rtopoDs, paths.rtopo];
    })();
    let json: BathyGrid | null = null;
    for (const url of candidates) {
      // Avoid loading huge JSON by accident; prefer a downsampled file.
      if (effective !== "rtopo" && url.endsWith("bathy_RTopo.json")) {
        try {
          const head = await fetch(url, { method: "HEAD" });
          const len = Number(head.headers.get("Content-Length") ?? "0");
          // ~30MB threshold: above this, parsing can freeze the tab on many machines.
          if (Number.isFinite(len) && len > 30 * 1024 * 1024) {
            // Skip; fall back to ds or bathy.json.
            console.warn(
              `Skipping ${url} (${Math.round(len / (1024 * 1024))} MB). ` +
                `Create bathy_RTopo_ds.json for performance, or force with ?bathy=rtopo.`
            );
            continue;
          }
        } catch {
          // ignore HEAD errors; try GET anyway
        }
      }
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) continue;
      json = parsePossiblyNonStandardJson<BathyGrid>(await r.text());
      break;
    }
    if (!json) return null;
    if (!Array.isArray(json?.lon) || !Array.isArray(json?.lat) || !Array.isArray(json?.z)) {
      return null;
    }

    // Normalize z into a numeric 2D array.
    const zNumeric: number[][] = json.z.map((row) => (Array.isArray(row) ? row.map((v) => Number(v)) : []));

    // Determine sign convention robustly (avoid sampling bias: RTopo often has land in the top-left).
    // Conventions we support:
    // - ocean depth already negative (preferred): keep as-is
    // - ocean depth positive-down (common): flip sign so Plotly shows a basin
    // If both positive and negative exist, assume:
    // - positive => land elevation (clamp to 0 to focus on ocean)
    // - negative => ocean depth
    let hasNeg = false;
    let hasPos = false;
    outer: for (let j = 0; j < zNumeric.length; j++) {
      const row = zNumeric[j];
      if (!Array.isArray(row)) continue;
      for (let i = 0; i < row.length; i++) {
        const v = Number((row as any)[i]);
        if (!Number.isFinite(v) || v === 0) continue;
        if (v < 0) hasNeg = true;
        if (v > 0) hasPos = true;
        if (hasNeg && hasPos) break outer;
      }
    }

    // If the grid has no negatives but has positives, treat it as "positive-down depth" and flip.
    if (!hasNeg && hasPos) {
      for (let j = 0; j < zNumeric.length; j++) {
        const row = zNumeric[j];
        for (let i = 0; i < row.length; i++) row[i] = -row[i];
      }
      hasNeg = true;
      hasPos = false;
    }

    // Keep signed z for coloring (land positive, ocean negative). For geometry, clamp land to 0
    // so the z-axis focuses on ocean depth.
    const zRaw = zNumeric;
    const zGeom = zRaw.map((row) => row.map((v) => (Number.isFinite(v) ? Math.min(0, v) : v)));
    json.zRaw = zRaw;
    json.z = zGeom;

    // Plotly surface performance: keep grid under a manageable size.
    // RTopo can be thousands x thousands; downsample deterministically.
    const nLat = json.lat.length;
    const nLon = json.lon.length;
    const maxPoints = 250_000;
    const nPoints = nLat * nLon;
    if (nPoints > maxPoints && nLat > 0 && nLon > 0) {
      const targetLat = Math.max(80, Math.floor(Math.sqrt((maxPoints * nLat) / nLon)));
      const targetLon = Math.max(80, Math.floor(maxPoints / targetLat));
      const strideLat = Math.max(1, Math.ceil(nLat / targetLat));
      const strideLon = Math.max(1, Math.ceil(nLon / targetLon));

      const latIdx: number[] = [];
      for (let j = 0; j < nLat; j += strideLat) latIdx.push(j);
      if (latIdx[latIdx.length - 1] !== nLat - 1) latIdx.push(nLat - 1);

      const lonIdx: number[] = [];
      for (let i = 0; i < nLon; i += strideLon) lonIdx.push(i);
      if (lonIdx[lonIdx.length - 1] !== nLon - 1) lonIdx.push(nLon - 1);

      const zRawDown = (json as any).zRaw
        ? latIdx.map((j) => lonIdx.map((i) => Number((json as any).zRaw[j][i])))
        : undefined;
      json = {
        lon: lonIdx.map((i) => Number(json!.lon[i])),
        lat: latIdx.map((j) => Number(json!.lat[j])),
        z: latIdx.map((j) => lonIdx.map((i) => Number((json!.z as any)[j][i]))),
        zRaw: zRawDown,
      };
    }

    return json;
  } catch {
    return null;
  }
}

const DEFAULT_SCENE_CAMERA = {
  // Meridional (northward-facing) default view: camera is south of domain.
  eye: { x: 0.12, y: -2.15, z: 0.62 },
};

const SCENE_CAMERA_STORAGE_KEY = "gs_scene_camera_v1";
const WIND_TRACE_COLOR_DEFAULT = "rgba(255,255,255,0.92)";
const STABLE_SCENE_OVERLAY_Z_MAX_M = 110;

function xformMatrix(m: ArrayLike<number>, v: [number, number, number, number]) {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const vi = v[i];
    out[0] += Number(m[4 * i + 0]) * vi;
    out[1] += Number(m[4 * i + 1]) * vi;
    out[2] += Number(m[4 * i + 2]) * vi;
    out[3] += Number(m[4 * i + 3]) * vi;
  }
  return out;
}

function xformMatrixRowMajor(m: ArrayLike<number>, v: [number, number, number, number]) {
  return [
    Number(m[0]) * v[0] + Number(m[1]) * v[1] + Number(m[2]) * v[2] + Number(m[3]) * v[3],
    Number(m[4]) * v[0] + Number(m[5]) * v[1] + Number(m[6]) * v[2] + Number(m[7]) * v[3],
    Number(m[8]) * v[0] + Number(m[9]) * v[1] + Number(m[10]) * v[2] + Number(m[11]) * v[3],
    Number(m[12]) * v[0] + Number(m[13]) * v[1] + Number(m[14]) * v[2] + Number(m[15]) * v[3],
  ] as [number, number, number, number];
}

function projectPointWithCameraParams(
  cameraParams: any,
  x: number,
  y: number,
  z: number
): [number, number, number, number] | null {
  const model = cameraParams?.model as ArrayLike<number> | undefined;
  const view = cameraParams?.view as ArrayLike<number> | undefined;
  const projection = cameraParams?.projection as ArrayLike<number> | undefined;
  if (!model || !view || !projection) return null;
  const p0 = xformMatrix(model, [x, y, z, 1]);
  const p1 = xformMatrix(view, p0);
  return xformMatrix(projection, p1);
}

function projectPointWithCameraParamsRowMajor(
  cameraParams: any,
  x: number,
  y: number,
  z: number
): [number, number, number, number] | null {
  const model = cameraParams?.model as ArrayLike<number> | undefined;
  const view = cameraParams?.view as ArrayLike<number> | undefined;
  const projection = cameraParams?.projection as ArrayLike<number> | undefined;
  if (!model || !view || !projection) return null;
  const p0 = xformMatrixRowMajor(model, [x, y, z, 1]);
  const p1 = xformMatrixRowMajor(view, p0);
  return xformMatrixRowMajor(projection, p1);
}

function resolveSceneViewport(
  graphDiv: any,
  sceneObj: any,
  fallbackWidth: number,
  fallbackHeight: number
) {
  const graphRect = graphDiv?.getBoundingClientRect?.();
  const domCandidates = [
    sceneObj?.container,
    sceneObj?.glplot?.container,
    sceneObj?.glplot?.canvas,
  ].filter(Boolean);

  for (const node of domCandidates) {
    const rect = node?.getBoundingClientRect?.();
    if (!rect || !graphRect) continue;
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) continue;
    return {
      left: rect.left - graphRect.left,
      top: rect.top - graphRect.top,
      width,
      height,
    };
  }

  const fullLayout = graphDiv?._fullLayout;
  const sceneLayout = fullLayout?.scene;
  const margin = fullLayout?.margin ?? {};
  const l = Number(margin.l ?? 0);
  const r = Number(margin.r ?? 0);
  const t = Number(margin.t ?? 0);
  const b = Number(margin.b ?? 0);
  const plotWidth = Math.max(1, fallbackWidth - l - r);
  const plotHeight = Math.max(1, fallbackHeight - t - b);
  const domainX = Array.isArray(sceneLayout?.domain?.x) ? sceneLayout.domain.x : [0, 1];
  const domainY = Array.isArray(sceneLayout?.domain?.y) ? sceneLayout.domain.y : [0, 1];
  const x0 = Number(domainX[0] ?? 0);
  const x1 = Number(domainX[1] ?? 1);
  const y0 = Number(domainY[0] ?? 0);
  const y1 = Number(domainY[1] ?? 1);

  return {
    left: l + Math.max(0, Math.min(1, x0)) * plotWidth,
    top: t + (1 - Math.max(0, Math.min(1, y1))) * plotHeight,
    width: Math.max(1, Math.abs(x1 - x0) * plotWidth),
    height: Math.max(1, Math.abs(y1 - y0) * plotHeight),
  };
}

function normalizeCamera(input: any): any | null {
  if (!input || typeof input !== "object") return null;
  const pickVec3 = (v: any) => {
    if (!v || typeof v !== "object") return null;
    const x = Number(v.x);
    const y = Number(v.y);
    const z = Number(v.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
  };

  const eye = pickVec3((input as any).eye);
  const up = pickVec3((input as any).up);
  const center = pickVec3((input as any).center);
  const projectionType =
    typeof (input as any)?.projection?.type === "string" ? (input as any).projection.type : null;

  const out: any = {};
  if (eye) out.eye = eye;
  if (up) out.up = up;
  if (center) out.center = center;
  if (projectionType) out.projection = { type: projectionType };
  return Object.keys(out).length ? out : null;
}

function cameraSignature(input: any) {
  const cam = normalizeCamera(input);
  return cam ? JSON.stringify(cam) : null;
}

function cameraFacingTransect(opts: {
  lon: number[];
  lat: number[];
  xRange: [number, number];
  yRange: [number, number];
  baseCamera: any;
}) {
  const n = Math.min(opts.lon.length, opts.lat.length);
  const baseCamera = normalizeCamera(opts.baseCamera) ?? DEFAULT_SCENE_CAMERA;
  if (n < 2) return baseCamera;

  let dx = Number(opts.lon[n - 1]) - Number(opts.lon[0]);
  let dy = Number(opts.lat[n - 1]) - Number(opts.lat[0]);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return baseCamera;

  const xSpan = Math.max(1e-6, Math.abs(Number(opts.xRange[1]) - Number(opts.xRange[0])));
  const ySpan = Math.max(1e-6, Math.abs(Number(opts.yRange[1]) - Number(opts.yRange[0])));
  dx /= xSpan;
  dy /= ySpan;

  const pathLen = Math.hypot(dx, dy);
  if (pathLen <= 1e-6) return baseCamera;

  let nx = -dy / pathLen;
  let ny = dx / pathLen;
  const baseEye = baseCamera.eye ?? DEFAULT_SCENE_CAMERA.eye;
  const refX = Number(baseEye.x ?? DEFAULT_SCENE_CAMERA.eye.x);
  const refY = Number(baseEye.y ?? DEFAULT_SCENE_CAMERA.eye.y);
  if (nx * refX + ny * refY < 0) {
    nx = -nx;
    ny = -ny;
  }

  const horizontalMag = Math.max(1.65, Math.hypot(refX, refY));
  const eyeZ = Math.max(0.62, Number(baseEye.z ?? DEFAULT_SCENE_CAMERA.eye.z));
  return normalizeCamera({
    ...baseCamera,
    eye: { x: nx * horizontalMag, y: ny * horizontalMag, z: eyeZ },
    up: baseCamera.up ?? { x: 0, y: 0, z: 1 },
  });
}

function extractSurfacePick(event: any): { lon: number; lat: number } | null {
  const points = Array.isArray(event?.points) ? event.points : [];
  for (let i = 0; i < points.length; i++) {
    const candidate = points[i];
    const traceType = candidate?.data?.type ?? candidate?.fullData?.type;
    if (traceType !== "surface") continue;
    const lon = Number(candidate?.x);
    const lat = Number(candidate?.y);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat };
  }
  return null;
}

export default function Basemap3D(props: {
  bathySource?: "auto" | "bathy" | "rtopo_ds" | "rtopo";
  bathyPalette?: RGB[];
  bathyOpacity?: number;
  compactLayout?: boolean;
  depthRatio?: number;
  depthWarp?: {
    mode: "linear" | "upper";
    // Positive meters (e.g., 2500 means "upper 2500 m").
    focusDepthM?: number;
    // 0..1. Lower compresses deep ocean more; 1 == linear.
    deepRatio?: number;
  };
  showBathy?: boolean;
  horizontalOverlay?: {
    enabled: boolean;
    imagePath: string;
    bounds: LonLatBounds;
    opacity?: number;
    mode?: "surface" | "bathy";
    colormap?: "rdylbu_r";
    valueRange?: { min: number; max: number };
    showScale?: boolean;
    flipLon?: boolean;
    flipLat?: boolean;
  };
  horizontalField?: HorizontalField;
  // Extra numeric planes (e.g., stacked depth slices, sea ice at z=0).
  horizontalPlanes?: HorizontalField[];
  transectOverlay?: {
    enabled: boolean;
    imagePath: string;
    lat: number;
    bounds: LonDepthBounds;
    opacity?: number;
  };
  transectField?: TransectField;
  guidePath?: GuidePath;
  windLayer?: WindLayer;
  classLayer?: ClassLayer;
  eddyLayer?: EddyLayer;
  onSurfacePick?: (pick: { lon: number; lat: number }) => void;
  onSurfaceHover?: (pick: { lon: number; lat: number } | null) => void;
  onStatusChange?: (status: {
    plotly: "loading" | "ready" | "failed";
    bathy: "loading" | "file" | "synthetic";
    horizontalImage: "off" | "loading" | "ready" | "failed";
    transectImage: "off" | "loading" | "ready" | "failed";
  }) => void;
  showBathyContours?: boolean;
  showFieldContours?: boolean;
  cameraFocusPath?: { nonce: number; lon: number[]; lat: number[] };
  cameraResetNonce?: number;
}) {
  const [grid, setGrid] = useState<BathyGrid | null>(null);
  const [bathyStatus, setBathyStatus] = useState<"loading" | "file" | "synthetic">(
    "loading"
  );
  const [Plot, setPlot] = useState<React.ComponentType<any> | null>(null);
  const [graphDivVersion, setGraphDivVersion] = useState(0);
  const plotlyLibRef = useRef<any | null>(null);
  const didInitCameraRef = useRef(false);
  const graphDivRef = useRef<any | null>(null);
  const lastSavedCameraJsonRef = useRef<string | null>(null);
  const lastKnownCameraRef = useRef<any | null>(null);
  const lastSurfaceHoverPickRef = useRef<{ lon: number; lat: number } | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const saveRafRef = useRef<number | null>(null);
  const initialCameraRef = useRef<any | null>(null);
  const skipNextCameraPersistRef = useRef(false);
  const lastCameraFocusNonceRef = useRef<number | null>(null);
  const windCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const windParticlesRef = useRef<WindParticle[]>([]);
  const windAnimRafRef = useRef<number | null>(null);
  const windLastTsRef = useRef(0);
  const windLastDrawTsRef = useRef(0);
  const [plotStatus, setPlotStatus] = useState<"loading" | "ready" | "failed">(
    "loading"
  );
  const [horizontalImg, setHorizontalImg] = useState<ImageData | null>(null);
  const [transectImg, setTransectImg] = useState<ImageData | null>(null);
  const [horizontalImgStatus, setHorizontalImgStatus] = useState<
    "off" | "loading" | "ready" | "failed"
  >("off");
  const [transectImgStatus, setTransectImgStatus] = useState<
    "off" | "loading" | "ready" | "failed"
  >("off");

  const horizontalColorCacheRef = useRef<
    Map<
      string,
      {
        surfacecolor: number[][];
        colorscale: Array<[number, string]>;
        cmin: number;
        cmax: number;
      }
    >
  >(new Map());
  const transectCurtainCacheRef = useRef<
    Map<string, { x: number[]; y: number[]; z: number[][]; surfacecolor: number[][] }>
  >(new Map());

  useEffect(() => {
    let cancelled = false;
    setBathyStatus("loading");
    tryLoadBathyJson(props.bathySource).then((g) => {
      if (cancelled) return;
      setGrid(g);
      setBathyStatus(g ? "file" : "synthetic");
    });
    return () => {
      cancelled = true;
    };
  }, [props.bathySource]);

  useEffect(() => {
    const overlay = props.horizontalOverlay;
    if (!overlay?.enabled) {
      setHorizontalImg(null);
      setHorizontalImgStatus("off");
      return;
    }
    let cancelled = false;
    setHorizontalImgStatus("loading");
    loadImageData(withBase(overlay.imagePath))
      .then((img) => {
        if (cancelled) return;
        // Clear cache entries if it grows too large.
        const cache = horizontalColorCacheRef.current;
        if (cache.size > 24) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
        setHorizontalImg(img);
        setHorizontalImgStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load horizontal overlay image:", overlay.imagePath, e);
        setHorizontalImg(null);
        setHorizontalImgStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [props.horizontalOverlay?.enabled, props.horizontalOverlay?.imagePath]);

  useEffect(() => {
    const overlay = props.transectOverlay;
    if (!overlay?.enabled) {
      setTransectImg(null);
      setTransectImgStatus("off");
      return;
    }
    let cancelled = false;
    setTransectImgStatus("loading");
    loadImageData(withBase(overlay.imagePath))
      .then((img) => {
        if (cancelled) return;
        const cache = transectCurtainCacheRef.current;
        if (cache.size > 16) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
        setTransectImg(img);
        setTransectImgStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load transect overlay image:", overlay.imagePath, e);
        setTransectImg(null);
        setTransectImgStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [props.transectOverlay?.enabled, props.transectOverlay?.imagePath]);

  useEffect(() => {
    let cancelled = false;
    setPlotStatus("loading");
    Promise.all([
      import("react-plotly.js/factory"),
      import("plotly.js-dist-min"),
    ])
      .then(([factory, plotly]) => {
        if (cancelled) return;
        const createPlotlyComponent =
          (factory as any)?.default ?? (factory as any);
        const Plotly = (plotly as any)?.default ?? (plotly as any);
        if (typeof createPlotlyComponent !== "function" || !Plotly) {
          setPlot(null);
          setPlotStatus("failed");
          return;
        }
        plotlyLibRef.current = Plotly;
        setPlot(() => createPlotlyComponent(Plotly));
        setPlotStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPlot(null);
        setPlotStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Load initial camera once (per mount). If present, it becomes the default view for this user.
    if (initialCameraRef.current) return;
    try {
      const raw = window.localStorage.getItem(SCENE_CAMERA_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const cam = normalizeCamera(parsed);
      if (cam) initialCameraRef.current = cam;
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    props.onStatusChange?.({
      plotly: plotStatus,
      bathy: bathyStatus,
      horizontalImage: horizontalImgStatus,
      transectImage: transectImgStatus,
    });
  }, [bathyStatus, horizontalImgStatus, plotStatus, props.onStatusChange, transectImgStatus]);

  const bathy = useMemo(() => grid ?? makeSyntheticGreenlandSeaBathy(), [grid]);
  const bathyHasOceanNeg = useMemo(() => {
    const zRaw = (grid as any)?.zRaw as number[][] | undefined;
    if (!zRaw) return false;
    for (let j = 0; j < zRaw.length; j++) {
      const row = zRaw[j];
      if (!Array.isArray(row)) continue;
      for (let i = 0; i < row.length; i++) {
        const v = Number(row[i]);
        if (Number.isFinite(v) && v < -0.5) return true; // allow small noise near 0
      }
    }
    return false;
  }, [grid]);

  const colorscale332 = useMemo(() => makeDiscreteColorscale332(), []);
  const rdylbuPalette = useMemo<RGB[]>(() => rdylbu_r_256(), []);
  const rdylbuColorscale = useMemo(() => paletteToColorscale(rdylbuPalette), [rdylbuPalette]);
  const defaultBathyPalette = useMemo<RGB[]>(() => deep_256(), []);
  const activeBathyPalette = useMemo<RGB[]>(
    () => (props.bathyPalette?.length ? props.bathyPalette : defaultBathyPalette),
    [defaultBathyPalette, props.bathyPalette]
  );
  const topoPalette = useMemo<RGB[]>(() => topo_256(), []);
  const topoColorscale = useMemo(() => paletteToColorscale(topoPalette), [topoPalette]);

  const depthWarp = useMemo(() => {
    const mode = props.depthWarp?.mode ?? "linear";
    const focusDepthM = Math.max(50, Math.min(20000, Number(props.depthWarp?.focusDepthM ?? 2500)));
    const deepRatio = Math.max(0.05, Math.min(1, Number(props.depthWarp?.deepRatio ?? 0.25)));
    return { mode, focusDepthM, deepRatio } as const;
  }, [props.depthWarp?.deepRatio, props.depthWarp?.focusDepthM, props.depthWarp?.mode]);

  const scaleZ = useCallback(
    (z: number) => {
      const v = Number(z);
      if (!Number.isFinite(v)) return v;
      if (v >= 0) return v; // above or at sea level: leave as-is
      if (depthWarp.mode === "linear") return v;

      // Upper-focus: keep 0..-focusDepth linear, compress deeper part by deepRatio.
      const depth = -v; // positive down
      const focus = depthWarp.focusDepthM;
      if (depth <= focus) return v;
      const scaledDepth = focus + (depth - focus) * depthWarp.deepRatio;
      return -scaledDepth;
    },
    [depthWarp.deepRatio, depthWarp.focusDepthM, depthWarp.mode]
  );

  useEffect(() => {
    if (windAnimRafRef.current != null) {
      window.cancelAnimationFrame(windAnimRafRef.current);
      windAnimRafRef.current = null;
    }
    windParticlesRef.current = [];
    windLastTsRef.current = 0;
    windLastDrawTsRef.current = 0;
    const clearCanvas = () => {
      const canvas = windCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    clearCanvas();

    const layer = props.windLayer;
    if (!layer?.enabled) return;
    const lon = layer.lon ?? [];
    const lat = layer.lat ?? [];
    const u = layer.u ?? [];
    const v = layer.v ?? [];
    const nx = lon.length;
    const ny = lat.length;
    if (!nx || !ny) return;
    if (u.length !== ny || v.length !== ny) return;
    if ((u[0]?.length ?? 0) !== nx || (v[0]?.length ?? 0) !== nx) return;

    const lonStart = Number(lon[0]);
    const lonEnd = Number(lon[nx - 1]);
    const latStart = Number(lat[0]);
    const latEnd = Number(lat[ny - 1]);
    const lonAsc = lonEnd >= lonStart;
    const latAsc = latEnd >= latStart;

    const edgeMinActiveCount = 8;
    const rowActiveCounts = new Array(ny).fill(0);
    const colActiveCounts = new Array(nx).fill(0);
    let maxMag = 0;
    for (let j = 0; j < ny; j++) {
      const ur = u[j];
      const vr = v[j];
      if (!Array.isArray(ur) || !Array.isArray(vr)) continue;
      for (let i = 0; i < nx; i++) {
        const uu = Number(ur[i]);
        const vv = Number(vr[i]);
        if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue;
        const m = Math.hypot(uu, vv);
        if (m > maxMag) maxMag = m;
        if (m > 1e-8) {
          rowActiveCounts[j] += 1;
          colActiveCounts[i] += 1;
        }
      }
    }

    const firstActiveRow = rowActiveCounts.findIndex((count) => count >= edgeMinActiveCount);
    const firstActiveCol = colActiveCounts.findIndex((count) => count >= edgeMinActiveCount);
    const lastActiveRow = (() => {
      for (let j = ny - 1; j >= 0; j--) {
        if (rowActiveCounts[j] >= edgeMinActiveCount) return j;
      }
      return -1;
    })();
    const lastActiveCol = (() => {
      for (let i = nx - 1; i >= 0; i--) {
        if (colActiveCounts[i] >= edgeMinActiveCount) return i;
      }
      return -1;
    })();
    if (firstActiveRow < 0 || firstActiveCol < 0 || lastActiveRow < firstActiveRow || lastActiveCol < firstActiveCol) {
      return;
    }

    const activeLonStart = Number(lon[firstActiveCol]);
    const activeLonEnd = Number(lon[lastActiveCol]);
    const activeLatStart = Number(lat[firstActiveRow]);
    const activeLatEnd = Number(lat[lastActiveRow]);
    const lonMin = Math.min(activeLonStart, activeLonEnd);
    const lonMax = Math.max(activeLonStart, activeLonEnd);
    const latMin = Math.min(activeLatStart, activeLatEnd);
    const latMax = Math.max(activeLatStart, activeLatEnd);
    const lonSpan = Math.max(1e-9, lonMax - lonMin);
    const latSpan = Math.max(1e-9, latMax - latMin);
    const activeNx = lastActiveCol - firstActiveCol + 1;
    const activeNy = lastActiveRow - firstActiveRow + 1;

    const bathyLon = bathy.lon ?? [];
    const bathyLat = bathy.lat ?? [];
    const bathyDepth = (bathy.zRaw ?? bathy.z) as number[][];
    const bathyNx = bathyLon.length;
    const bathyNy = bathyLat.length;
    const hasBathyMask =
      bathyNx > 1 &&
      bathyNy > 1 &&
      Array.isArray(bathyDepth) &&
      bathyDepth.length === bathyNy &&
      (bathyDepth[0]?.length ?? 0) === bathyNx;
    const bathyLonStart = Number(bathyLon[0]);
    const bathyLonEnd = Number(bathyLon[bathyNx - 1]);
    const bathyLatStart = Number(bathyLat[0]);
    const bathyLatEnd = Number(bathyLat[bathyNy - 1]);
    const bathyLonMin = Math.min(bathyLonStart, bathyLonEnd);
    const bathyLonMax = Math.max(bathyLonStart, bathyLonEnd);
    const bathyLatMin = Math.min(bathyLatStart, bathyLatEnd);
    const bathyLatMax = Math.max(bathyLatStart, bathyLatEnd);
    const bathyLonSpan = Math.max(1e-9, bathyLonMax - bathyLonMin);
    const bathyLatSpan = Math.max(1e-9, bathyLatMax - bathyLatMin);
    const bathyLonAsc = bathyLonEnd >= bathyLonStart;
    const bathyLatAsc = bathyLatEnd >= bathyLatStart;
    const oceanMaskMinDepthM = -5;
    const isOcean = (x: number, y: number) => {
      if (!hasBathyMask) return true;
      if (x < bathyLonMin || x > bathyLonMax || y < bathyLatMin || y > bathyLatMax) return false;
      const tx = (x - bathyLonMin) / bathyLonSpan;
      const ty = (y - bathyLatMin) / bathyLatSpan;
      const cx = tx * (bathyNx - 1);
      const cy = ty * (bathyNy - 1);
      const ux = bathyLonAsc ? cx : bathyNx - 1 - cx;
      const uy = bathyLatAsc ? cy : bathyNy - 1 - cy;
      const i0 = Math.max(0, Math.min(bathyNx - 1, Math.floor(ux)));
      const j0 = Math.max(0, Math.min(bathyNy - 1, Math.floor(uy)));
      const i1 = Math.min(bathyNx - 1, i0 + 1);
      const j1 = Math.min(bathyNy - 1, j0 + 1);
      const fx = Math.max(0, Math.min(1, ux - i0));
      const fy = Math.max(0, Math.min(1, uy - j0));

      const d00 = Number(bathyDepth[j0]?.[i0]);
      const d10 = Number(bathyDepth[j0]?.[i1]);
      const d01 = Number(bathyDepth[j1]?.[i0]);
      const d11 = Number(bathyDepth[j1]?.[i1]);
      if (!Number.isFinite(d00) || !Number.isFinite(d10) || !Number.isFinite(d01) || !Number.isFinite(d11)) {
        return false;
      }

      // Tight shoreline rejection: require at least two wet corners and
      // interpolated depth meaningfully below sea level.
      const wetCorners = Number(d00 < 0) + Number(d10 < 0) + Number(d01 < 0) + Number(d11 < 0);
      if (wetCorners < 2) return false;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const depth = d00 * w00 + d10 * w10 + d01 * w01 + d11 * w11;
      return depth < oceanMaskMinDepthM;
    };

    const toLonCoord = (x: number) => {
      const t = (x - lonMin) / lonSpan;
      const c = t * (activeNx - 1);
      return lonAsc ? firstActiveCol + c : lastActiveCol - c;
    };
    const toLatCoord = (y: number) => {
      const t = (y - latMin) / latSpan;
      const c = t * (activeNy - 1);
      return latAsc ? firstActiveRow + c : lastActiveRow - c;
    };

    const sample = (x: number, y: number) => {
      if (x < lonMin || x > lonMax || y < latMin || y > latMax) return null;
      if (!isOcean(x, y)) return null;
      const cx = toLonCoord(x);
      const cy = toLatCoord(y);
      const i0 = Math.max(0, Math.min(nx - 1, Math.floor(cx)));
      const j0 = Math.max(0, Math.min(ny - 1, Math.floor(cy)));
      const i1 = Math.min(nx - 1, i0 + 1);
      const j1 = Math.min(ny - 1, j0 + 1);
      const fx = Math.max(0, Math.min(1, cx - i0));
      const fy = Math.max(0, Math.min(1, cy - j0));

      const corners = [
        { i: i0, j: j0, w: (1 - fx) * (1 - fy) },
        { i: i1, j: j0, w: fx * (1 - fy) },
        { i: i0, j: j1, w: (1 - fx) * fy },
        { i: i1, j: j1, w: fx * fy },
      ];

      let sumW = 0;
      let sumU = 0;
      let sumV = 0;
      for (const c of corners) {
        if (!isOcean(Number(lon[c.i]), Number(lat[c.j]))) continue;
        const uu = Number(u[c.j]?.[c.i]);
        const vv = Number(v[c.j]?.[c.i]);
        if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue;
        sumW += c.w;
        sumU += uu * c.w;
        sumV += vv * c.w;
      }
      if (sumW <= 1e-8) return null;
      return { uu: sumU / sumW, vv: sumV / sumW };
    };
    const targetDegPerSec = 1.8 * Math.max(0.1, Number(layer.speed ?? 1));
    const advectScale = maxMag > 1e-6 ? Math.min(120, targetDegPerSec / maxMag) : 0;
    const nParticles = Math.max(96, Math.min(2600, Math.round(Number(layer.particleCount ?? 1200))));
    const trailLen = Math.max(14, Math.min(42, Math.round((layer.size ?? 1.4) * 13)));
    const lineWidth = Math.max(0.9, Number(layer.size ?? 1.7) * 0.92);
    const headRadius = Math.max(1.3, lineWidth * 0.9);
    const lineColor = layer.color ?? WIND_TRACE_COLOR_DEFAULT;
    const zVal = scaleZ(layer.zPlane ?? 6);
    const colorForMag = () => lineColor;
    const makeParticleAt = (x: number, y: number): WindParticle | null => {
      if (!isOcean(x, y)) return null;
      const w = sample(x, y);
      if (!w) return null;
      const speedMag = Math.hypot(w.uu, w.vv);
      if (speedMag <= 1e-8) return null;
      return { x, y, ttl: 2 + Math.random() * 6, speedMag, trailX: [x], trailY: [y], trailMag: [speedMag] };
    };
    const spawnRandom = (): WindParticle => {
      for (let k = 0; k < 80; k++) {
        const x = lonMin + Math.random() * lonSpan;
        const y = latMin + Math.random() * latSpan;
        const particle = makeParticleAt(x, y);
        if (particle) return particle;
      }
      const x = (lonMin + lonMax) * 0.5;
      const y = (latMin + latMax) * 0.5;
      return { x, y, ttl: 2 + Math.random() * 6, speedMag: 0, trailX: [x], trailY: [y], trailMag: [0] };
    };
    const spawnSeeded = (index: number): WindParticle => {
      const aspect = Math.max(0.35, Math.min(4, lonSpan / Math.max(1e-9, latSpan)));
      const cols = Math.max(1, Math.round(Math.sqrt(nParticles * aspect)));
      const rows = Math.max(1, Math.ceil(nParticles / cols));
      const col = index % cols;
      const row = Math.floor(index / cols) % rows;
      const jitterX = ((index * 0.61803398875) % 1) - 0.5;
      const jitterY = ((index * 0.41421356237) % 1) - 0.5;
      const baseX = lonMin + ((col + 0.5 + jitterX * 0.7) / cols) * lonSpan;
      const baseY = latMin + ((row + 0.5 + jitterY * 0.7) / rows) * latSpan;
      const dx = lonSpan / Math.max(1, cols);
      const dy = latSpan / Math.max(1, rows);
      for (let k = 0; k < 10; k++) {
        const x = baseX + (Math.random() - 0.5) * dx * 0.9;
        const y = baseY + (Math.random() - 0.5) * dy * 0.9;
        const particle = makeParticleAt(x, y);
        if (particle) return particle;
      }
      return spawnRandom();
    };
    const spawn = (seedIndex?: number): WindParticle =>
      Number.isFinite(seedIndex) ? spawnSeeded(Number(seedIndex)) : spawnRandom();

    const particles = Array.from({ length: nParticles }, (_, idx) => spawn(idx));
    windParticlesRef.current = particles;

    const draw = () => {
      const canvas = windCanvasRef.current;
      const graphDiv = graphDivRef.current;
      if (!canvas || !graphDiv) return;
      const sceneObj = graphDiv?._fullLayout?.scene?._scene;
      const cameraParams = sceneObj?.glplot?.cameraParams;
      const dataScale = Array.isArray(sceneObj?.dataScale) ? sceneObj.dataScale : null;

      const cssW = Math.max(1, Math.round(canvas.clientWidth || graphDiv.clientWidth || 0));
      const cssH = Math.max(1, Math.round(canvas.clientHeight || graphDiv.clientHeight || 0));
      const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
      const targetW = Math.max(1, Math.round(cssW * dpr));
      const targetH = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      const sceneViewport = resolveSceneViewport(graphDiv, sceneObj, cssW, cssH);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const ds0 =
        dataScale && dataScale.length >= 3 && Number.isFinite(Number(dataScale[0])) ? Number(dataScale[0]) : null;
      const ds1 =
        dataScale && dataScale.length >= 3 && Number.isFinite(Number(dataScale[1])) ? Number(dataScale[1]) : null;
      const ds2 =
        dataScale && dataScale.length >= 3 && Number.isFinite(Number(dataScale[2])) ? Number(dataScale[2]) : null;
      const useDataScale = ds0 != null && ds1 != null && ds2 != null;
      const projectCandidates: Array<(x: number, y: number, z: number) => [number, number, number, number] | null> =
        [];
      if (cameraParams) {
        projectCandidates.push((x, y, z) => projectPointWithCameraParams(cameraParams, x, y, z));
        projectCandidates.push((x, y, z) => projectPointWithCameraParamsRowMajor(cameraParams, x, y, z));
        if (useDataScale) {
          projectCandidates.push((x, y, z) => projectPointWithCameraParams(cameraParams, x * ds0!, y * ds1!, z * ds2!));
          projectCandidates.push((x, y, z) =>
            projectPointWithCameraParamsRowMajor(cameraParams, x * ds0!, y * ds1!, z * ds2!)
          );
        }
      }
      const evalPoints: Array<[number, number]> = [
        [lonMin, latMin],
        [lonMax, latMin],
        [lonMax, latMax],
        [lonMin, latMax],
        [(lonMin + lonMax) * 0.5, (latMin + latMax) * 0.5],
      ];
      let bestProjector: ((x: number, y: number, z: number) => [number, number, number, number] | null) | null = null;
      let bestScore = -Infinity;
      for (const candidate of projectCandidates) {
        let inFrame = 0;
        let finite = 0;
        let sumAbs = 0;
        for (const [x, y] of evalPoints) {
          const p = candidate(x, y, zVal);
          if (!p) continue;
          const w = Number(p[3]);
          if (!Number.isFinite(w) || Math.abs(w) <= 1e-9) continue;
          const xn = Number(p[0]) / w;
          const yn = Number(p[1]) / w;
          if (!Number.isFinite(xn) || !Number.isFinite(yn)) continue;
          finite += 1;
          sumAbs += Math.abs(xn) + Math.abs(yn);
          if (Math.abs(xn) <= 1.3 && Math.abs(yn) <= 1.3) inFrame += 1;
        }
        if (!finite) continue;
        const score = inFrame * 100 - sumAbs;
        if (score > bestScore) {
          bestScore = score;
          bestProjector = candidate;
        }
      }
      const projectToScreen = (x: number, y: number, z: number) => {
        if (!bestProjector) return null;
        const projected = bestProjector(x, y, z);
        if (!projected) return null;
        const cx = Number(projected[0]);
        const cy = Number(projected[1]);
        const w = Number(projected[3]);
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(w)) return null;
        if (Math.abs(w) <= 1e-9) return null;
        const xn = cx / w;
        const yn = cy / w;
        if (!Number.isFinite(xn) || !Number.isFinite(yn)) return null;
        if (Math.abs(xn) > 1.12 || Math.abs(yn) > 1.12) return null;
        return {
          sx: sceneViewport.left + (0.5 + 0.5 * xn) * sceneViewport.width,
          sy: sceneViewport.top + (0.5 - 0.5 * yn) * sceneViewport.height,
        };
      };
      const drawSegment = (
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        mag: number,
        ageT: number
      ) => {
        ctx.strokeStyle = colorForMag(mag);
        ctx.globalAlpha = 0.12 + 0.72 * ageT * ageT;
        ctx.lineWidth = lineWidth * (0.58 + 0.62 * ageT);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      };
      const drawHead = (x: number, y: number, mag: number) => {
        ctx.fillStyle = colorForMag(mag);
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.arc(x, y, headRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(x, y, headRadius * 0.42, 0, Math.PI * 2);
        ctx.fill();
      };

      let drewProjected = false;
      for (const p of particles) {
        let prev: { sx: number; sy: number; mag: number } | null = null;
        let head: { sx: number; sy: number; mag: number } | null = null;
        for (let k = 0; k < p.trailX.length; k++) {
          const px = p.trailX[k];
          const py = p.trailY[k];
          if (!isOcean(px, py)) {
            prev = null;
            continue;
          }
          const projected = projectToScreen(px, py, zVal);
          if (!projected) {
            prev = null;
            continue;
          }
          const mag = Number(p.trailMag[k] ?? p.speedMag);
          if (prev) {
            const ageT = p.trailX.length > 1 ? k / (p.trailX.length - 1) : 1;
            drawSegment(prev.sx, prev.sy, projected.sx, projected.sy, Math.max(prev.mag, mag), ageT);
            drewProjected = true;
          }
          prev = { sx: projected.sx, sy: projected.sy, mag };
          head = prev;
        }
        if (head) {
          drawHead(head.sx, head.sy, head.mag);
          drewProjected = true;
        }
      }
      ctx.globalAlpha = 1;
      if (drewProjected) {
        return;
      }
      if (bestProjector) {
        // Avoid a misleading 2D fallback once a 3D camera is available.
        // If nothing projected this frame, skip drawing and wait for the next frame.
        return;
      }

      // Fallback: keep particles visible even if projection internals are unavailable.
      for (const p of particles) {
        let prev: { sx: number; sy: number; mag: number } | null = null;
        let head: { sx: number; sy: number; mag: number } | null = null;
        for (let k = 0; k < p.trailX.length; k++) {
          const x = p.trailX[k];
          const y = p.trailY[k];
          if (!isOcean(x, y)) {
            prev = null;
            continue;
          }
          const sx = ((x - lonMin) / lonSpan) * cssW;
          const sy = (1 - (y - latMin) / latSpan) * cssH;
          if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
            prev = null;
            continue;
          }
          const mappedX = sceneViewport.left + (sx / cssW) * sceneViewport.width;
          const mappedY = sceneViewport.top + (sy / cssH) * sceneViewport.height;
          const mag = Number(p.trailMag[k] ?? p.speedMag);
          if (prev) {
            const ageT = p.trailX.length > 1 ? k / (p.trailX.length - 1) : 1;
            drawSegment(prev.sx, prev.sy, mappedX, mappedY, Math.max(prev.mag, mag), ageT);
          }
          prev = { sx: mappedX, sy: mappedY, mag };
          head = prev;
        }
        if (head) {
          drawHead(head.sx, head.sy, head.mag);
        }
      }
      ctx.globalAlpha = 1;
    };

    draw();

    const tick = (ts: number) => {
      const dtRaw = windLastTsRef.current ? (ts - windLastTsRef.current) / 1000 : 1 / 60;
      windLastTsRef.current = ts;
      const dt = Math.max(0.001, Math.min(0.04, dtRaw));

      for (let idx = 0; idx < particles.length; idx++) {
        const p = particles[idx];
        if (p.ttl <= 0) {
          particles[idx] = spawn();
          continue;
        }
        const w = sample(p.x, p.y);
        if (!w) {
          particles[idx] = spawn();
          continue;
        }
        const k = advectScale * dt;
        const midX = p.x + w.uu * k * 0.5;
        const midY = p.y + w.vv * k * 0.5;
        const wMid = sample(midX, midY) ?? w;
        p.speedMag = Math.hypot(wMid.uu, wMid.vv);
        p.x += wMid.uu * k;
        p.y += wMid.vv * k;
        p.ttl -= dt;
        if (!isOcean(p.x, p.y)) {
          particles[idx] = spawn();
          continue;
        }
        p.trailX.push(p.x);
        p.trailY.push(p.y);
        p.trailMag.push(p.speedMag);
        if (p.trailX.length > trailLen) {
          const drop = p.trailX.length - trailLen;
          p.trailX.splice(0, drop);
          p.trailY.splice(0, drop);
          p.trailMag.splice(0, drop);
        }
        if (p.x < lonMin || p.x > lonMax || p.y < latMin || p.y > latMax) {
          particles[idx] = spawn();
        }
      }

      if (ts - windLastDrawTsRef.current >= 16) {
        windLastDrawTsRef.current = ts;
        draw();
      }
      windAnimRafRef.current = window.requestAnimationFrame(tick);
    };

    windAnimRafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (windAnimRafRef.current != null) {
        window.cancelAnimationFrame(windAnimRafRef.current);
        windAnimRafRef.current = null;
      }
      windParticlesRef.current = [];
      windLastTsRef.current = 0;
      windLastDrawTsRef.current = 0;
      clearCanvas();
    };
  }, [bathy, props.windLayer, scaleZ]);

  const bathyZPlot = useMemo(() => {
    // Apply non-linear depth scaling to the geometry only.
    // Keep bathy surfacecolor in physical units for the colormap.
    return bathy.z.map((row) => row.map((v) => (Number.isFinite(v) ? scaleZ(v) : v)));
  }, [bathy.z, scaleZ]);

  const zAxisTicks = useMemo(() => {
    // Show physical depths on the axis even if we warp the geometry.
    let minDepth = 0;
    for (const row of bathy.z) {
      for (const v of row) {
        const x = Number(v);
        if (!Number.isFinite(x)) continue;
        if (x < minDepth) minDepth = x;
      }
    }
    const physical = [0, -500, -1000, -1500, -2000, -2500, -3000, -4000, -5000, -6000].filter(
      (d) => d >= minDepth - 1e-6
    );
    const tickvals = physical.map((d) => scaleZ(d));
    const ticktext = physical.map((d) => `${Math.round(d)}`);
    return { tickvals, ticktext };
  }, [bathy.z, scaleZ]);

  function buildSstLookup(img: ImageData, vmin: number, vmax: number) {
    // Extract unique colors and order them along a reference RdYlBu_r palette
    // so interpolation behaves nicely while preserving the original PNG colors.
    const unique = new Map<number, { r: number; g: number; b: number }>();
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a < 10) continue;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const key = rgbKey(r, g, b);
      if (!unique.has(key)) unique.set(key, { r, g, b });
    }

    const denom = Math.max(1, rdylbuPalette.length - 1);
    const keyToValue = new Map<number, number>();
    for (const [key, c] of unique.entries()) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let k = 0; k < rdylbuPalette.length; k++) {
        const p = rdylbuPalette[k];
        const dist = Math.abs(c.r - p.r) + Math.abs(c.g - p.g) + Math.abs(c.b - p.b);
        if (dist < bestD) {
          bestD = dist;
          bestIdx = k;
          if (bestD === 0) break;
        }
      }
      const t = denom ? bestIdx / denom : 0;
      keyToValue.set(key, vmin + t * (vmax - vmin));
    }

    return { keyToValue, colorscale: rdylbuColorscale, cmin: vmin, cmax: vmax };
  }

  const horizontalColor = useMemo(() => {
    const overlay = props.horizontalOverlay;
    if (!overlay?.enabled || !horizontalImg) return null;

    const modeKey = overlay.colormap ?? "rgb332";
    const flipKey = `${overlay.flipLon ? 1 : 0}${overlay.flipLat ? 1 : 0}`;
    const rangeKey =
      overlay.colormap && overlay.valueRange
        ? `${overlay.valueRange.min}:${overlay.valueRange.max}`
        : "";
    const key = `${overlay.imagePath}|${modeKey}|${flipKey}|${rangeKey}`;

    const cached = horizontalColorCacheRef.current.get(key);
    if (cached) return cached;

    const { lonMin, lonMax, latMin, latMax } = overlay.bounds;
    const lonSpan = lonMax - lonMin;
    const latSpan = latMax - latMin;
    if (lonSpan === 0 || latSpan === 0) return null;

    const vmin = overlay.valueRange?.min ?? -1;
    const vmax = overlay.valueRange?.max ?? 8;
    const sstLookup =
      overlay.colormap === "rdylbu_r" ? buildSstLookup(horizontalImg, vmin, vmax) : null;

    const out: number[][] = [];
    for (let j = 0; j < bathy.lat.length; j++) {
      const row: number[] = [];
      const lat = bathy.lat[j];
      const vRaw = (latMax - lat) / latSpan; // top is latMax
      const v = overlay.flipLat ? 1 - vRaw : vRaw;
      const py = v * (horizontalImg.height - 1);
      for (let i = 0; i < bathy.lon.length; i++) {
        const lon = bathy.lon[i];
        const uRaw = (lon - lonMin) / lonSpan;
        const u = overlay.flipLon ? 1 - uRaw : uRaw;
        const px = u * (horizontalImg.width - 1);
        const { r, g, b, a } = getPixelRGBA(horizontalImg, px, py);
        if (a < 10) {
          row.push(Number.NaN);
          continue;
        }
        if (sstLookup) {
          const val = sstLookup.keyToValue.get(rgbKey(r, g, b));
          row.push(val ?? vmin);
        } else {
          row.push(rgbToIndex332(r, g, b));
        }
      }
      out.push(row);
    }

    const result = {
      surfacecolor: out,
      colorscale: (sstLookup ? sstLookup.colorscale : colorscale332) as Array<[number, string]>,
      cmin: sstLookup ? sstLookup.cmin : 0,
      cmax: sstLookup ? sstLookup.cmax : 255,
    };
    horizontalColorCacheRef.current.set(key, result);
    return result;
  }, [bathy.lat, bathy.lon, horizontalImg, props.horizontalOverlay]);

  const transectCurtain = useMemo(() => {
    const overlay = props.transectOverlay;
    if (!overlay?.enabled || !transectImg) return null;

    const key = `${overlay.imagePath}|${overlay.lat}|${overlay.bounds.lonMin}|${overlay.bounds.lonMax}|${overlay.bounds.depthMin}|${overlay.bounds.depthMax}`;
    const cached = transectCurtainCacheRef.current.get(key);
    if (cached) return cached;

    const { lonMin, lonMax, depthMin, depthMax } = overlay.bounds;
    const lonSpan = lonMax - lonMin;
    const depthSpan = depthMax - depthMin;
    if (lonSpan === 0 || depthSpan === 0) return null;

    const lon = bathy.lon.filter((x) => x >= Math.min(lonMin, lonMax) && x <= Math.max(lonMin, lonMax));
    const depth = (() => {
      const n = Math.max(40, Math.min(220, transectImg.height));
      const out: number[] = [];
      for (let k = 0; k < n; k++) out.push(depthMin + (k * depthSpan) / (n - 1));
      return out;
    })();

    const x: number[] = lon;
    const y: number[] = depth.map(() => overlay.lat);
    const z: number[][] = [];
    const surfacecolor: number[][] = [];

    for (let j = 0; j < depth.length; j++) {
      const depthM = depth[j];
      const v = (depthM - depthMin) / depthSpan; // top is depthMin (usually 0)
      const py = v * (transectImg.height - 1);
      const zRow: number[] = [];
      const cRow: number[] = [];
      for (let i = 0; i < x.length; i++) {
        const lonVal = x[i];
        const u = (lonVal - lonMin) / lonSpan;
        const px = u * (transectImg.width - 1);
        const { r, g, b, a } = getPixelRGBA(transectImg, px, py);
        zRow.push(-depthM);
        cRow.push(a < 10 ? 0 : rgbToIndex332(r, g, b));
      }
      z.push(zRow);
      surfacecolor.push(cRow);
    }

    const result = { x, y, z, surfacecolor };
    transectCurtainCacheRef.current.set(key, result);
    return result;
  }, [bathy.lon, props.transectOverlay, transectImg]);

  function fieldGridForPlane(field: HorizontalField) {
    const fLat = field.lat;
    const fLon = field.lon;
    const nRows = field.values.length;
    const nCols = field.values[0]?.length ?? 0;
    if (Array.isArray(fLat) && Array.isArray(fLon) && fLat.length === nRows && fLon.length === nCols) {
      return { x: fLon, y: fLat, values: field.values };
    }
    return { x: bathy.lon, y: bathy.lat, values: field.values };
  }

  const data = useMemo<Partial<PlotData>[]>(() => {
    const showBathy = props.showBathy !== false;
    const bathyOpacity = Math.max(0, Math.min(1, Number(props.bathyOpacity ?? 1)));
    const numericH = props.horizontalField?.enabled ? props.horizontalField : null;
    const pngOverlayEnabled = Boolean(props.horizontalOverlay?.enabled && horizontalColor);
    const overlayEnabled = Boolean(numericH || pngOverlayEnabled);
    const overlayMode = numericH?.mode ?? props.horizontalOverlay?.mode ?? "surface";
    const textureOnBathy = overlayEnabled && overlayMode === "bathy";

    const overlaySurfacecolor = (() => {
      const fieldValues = numericH?.values;
      if (!fieldValues) return horizontalColor?.surfacecolor as any;
      const nRows = fieldValues.length;
      const nCols = fieldValues[0]?.length ?? 0;
      if (nRows === bathy.lat.length && nCols === bathy.lon.length) return fieldValues;
      if (!numericH?.lon || !numericH?.lat) return fieldValues;

      // Nearest-neighbor resampling from field grid onto bathy grid.
      // Precompute lon/lat index maps.
      const lonMap = bathy.lon.map((x) => {
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < numericH.lon!.length; i++) {
          const d = Math.abs(numericH.lon![i] - x);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        return best;
      });
      const latMap = bathy.lat.map((y) => {
        let best = 0;
        let bestD = Infinity;
        for (let j = 0; j < numericH.lat!.length; j++) {
          const d = Math.abs(numericH.lat![j] - y);
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
        return best;
      });

      const out: number[][] = new Array(bathy.lat.length);
      for (let j = 0; j < bathy.lat.length; j++) {
        const srcJ = latMap[j];
        const srcRow = fieldValues[srcJ] ?? [];
        const row: number[] = new Array(bathy.lon.length);
        for (let i = 0; i < bathy.lon.length; i++) {
          row[i] = Number(srcRow[lonMap[i]]);
        }
        out[j] = row;
      }
      return out;
    })();
    const overlayColorscale = (numericH?.colorscale ?? horizontalColor?.colorscale) as
      | Array<[number, string]>
      | undefined;
    const overlayCmin = numericH?.cmin ?? horizontalColor?.cmin;
    const overlayCmax = numericH?.cmax ?? horizontalColor?.cmax;
    const overlayOpacity = numericH?.opacity ?? props.horizontalOverlay?.opacity ?? 0.85;
    const showOverlayScale = Boolean(numericH?.showScale ?? props.horizontalOverlay?.showScale);
    const overlayColorbarTitle = numericH?.colorbarTitle ?? "Value";
    const overlayColorbarTicks =
      numericH?.colorbarTicks ??
      (props.horizontalOverlay?.showScale ? [-1, 0, 1, 2, 3, 4, 5] : undefined);
    const overlayColorbarLen = numericH?.colorbarLen;
    const overlayColorbarX = numericH?.colorbarX;
    const overlayColorbarY = numericH?.colorbarY;

    const showContours = Boolean(props.showBathyContours);
    const showFieldContours = Boolean(props.showFieldContours);
    const traces: Partial<PlotData>[] = [];

    if (showBathy && textureOnBathy) {
      traces.push({
        type: "surface",
        name: "Bathy (textured)",
        x: bathy.lon,
        y: bathy.lat,
        z: bathyZPlot,
        surfacecolor: overlaySurfacecolor as any,
        cmin: overlayCmin,
        cmax: overlayCmax,
        cauto: false,
        colorscale: overlayColorscale as any,
        lighting: {
          ambient: 0.95,
          diffuse: 0.35,
          specular: 0.05,
          roughness: 0.95,
        } as any,
        flatshading: true as any,
        contours: {
          z: {
            show: showContours,
            highlight: showContours,
            usecolormap: false,
            color: "rgba(255,255,255,0.10)",
            highlightcolor: "limegreen",
            project: { z: false },
          },
        } as any,
        showscale: showOverlayScale,
        ...(showOverlayScale
          ? {
              colorbar: {
                ...makeColorbarConfig({
                  title: overlayColorbarTitle,
                  tickvals: overlayColorbarTicks,
                  len: overlayColorbarLen,
                  x: overlayColorbarX,
                  y: overlayColorbarY,
                }),
              } as any,
            }
          : null),
        opacity: bathyOpacity,
      });
    } else if (showBathy) {
      const zRaw = bathy.zRaw;
      if (zRaw && zRaw.length === bathy.lat.length && zRaw[0]?.length === bathy.lon.length) {
        const oceanLevels = [-4200, -3600, -3000, -2400, -1800, -1200, -600, -400, -200, -50]; // meters
        const levels = [...oceanLevels].sort((a, b) => a - b);
        const nBins = Math.max(1, levels.length - 1);
        const denom = Math.max(1, nBins - 1);
        const sampled = Array.from({ length: nBins }, (_, i) => {
          const t = denom ? i / denom : 0;
          const idx = Math.round(t * (activeBathyPalette.length - 1));
          return activeBathyPalette[idx];
        });
        const toCss = (c: RGB) => `rgb(${c.r},${c.g},${c.b})`;
        const oceanColorscale: Array<[number, string]> = [];
        const cmin = levels[0];
        const cmax = levels[levels.length - 1];
        const span = Math.max(1e-9, cmax - cmin);
        for (let i = 0; i < nBins; i++) {
          const t0 = (levels[i] - cmin) / span;
          const t1 = (levels[i + 1] - cmin) / span;
          const color = toCss(sampled[i]);
          oceanColorscale.push([t0, color], [t1, color]);
        }
        oceanColorscale[0][0] = 0;
        oceanColorscale[oceanColorscale.length - 1][0] = 1;

        const zOcean: number[][] = new Array(bathy.lat.length);
        const zOceanPlot: number[][] = new Array(bathy.lat.length);
        const zLand: number[][] = new Array(bathy.lat.length);
        const cLand: number[][] = new Array(bathy.lat.length);
        let landMax = 0;
        for (let j = 0; j < bathy.lat.length; j++) {
          const oceanRow: number[] = new Array(bathy.lon.length);
          const oceanPlotRow: number[] = new Array(bathy.lon.length);
          const landRow: number[] = new Array(bathy.lon.length);
          const cRow: number[] = new Array(bathy.lon.length);
          for (let i = 0; i < bathy.lon.length; i++) {
            const raw = Number(zRaw[j][i]);
            if (!Number.isFinite(raw)) {
              oceanRow[i] = Number.NaN;
              oceanPlotRow[i] = Number.NaN;
              landRow[i] = Number.NaN;
              cRow[i] = Number.NaN;
              continue;
            }
            if (raw < 0) {
              oceanRow[i] = Number(bathy.z[j][i]);
              oceanPlotRow[i] = scaleZ(Number(bathy.z[j][i]));
              landRow[i] = Number.NaN;
              cRow[i] = Number.NaN;
            } else if (raw > 0) {
              oceanRow[i] = Number.NaN;
              oceanPlotRow[i] = Number.NaN;
              landRow[i] = 0;
              cRow[i] = raw;
              landMax = Math.max(landMax, raw);
            } else {
              oceanRow[i] = 0;
              oceanPlotRow[i] = scaleZ(0);
              landRow[i] = Number.NaN;
              cRow[i] = Number.NaN;
            }
          }
          zOcean[j] = oceanRow;
          zOceanPlot[j] = oceanPlotRow;
          zLand[j] = landRow;
          cLand[j] = cRow;
        }

        traces.push({
          type: "surface",
          name: "Ocean bathymetry",
          x: bathy.lon,
          y: bathy.lat,
          z: zOceanPlot as any,
          surfacecolor: zOcean as any,
          cmin,
          cmax,
          cauto: false,
          colorscale: oceanColorscale as any,
          showscale: false,
          lighting: { ambient: 0.85, diffuse: 0.35, specular: 0.05, roughness: 0.95 } as any,
          flatshading: true as any,
          contours: {
            z: {
              show: showContours,
              highlight: showContours,
              usecolormap: false,
              color: "rgba(255,255,255,0.10)",
              highlightcolor: "limegreen",
              project: { z: false },
            },
          } as any,
          opacity: bathyOpacity,
        });

        // Land as a sea-level "cap" with topo coloring.
        if (landMax > 0) {
          traces.push({
            type: "surface",
            name: "Land (sea-level cap)",
            x: bathy.lon,
            y: bathy.lat,
            z: zLand as any,
            surfacecolor: cLand as any,
            cmin: 0,
            cmax: landMax,
            cauto: false,
            colorscale: topoColorscale as any,
            showscale: false,
            lighting: { ambient: 0.95, diffuse: 0.2, specular: 0.0, roughness: 1.0 } as any,
            flatshading: true as any,
            hoverinfo: "skip",
            opacity: bathyOpacity,
          });
        }
      } else {
        traces.push({
          type: "surface",
          name: "Bathy",
          x: bathy.lon,
          y: bathy.lat,
          z: bathyZPlot,
          colorscale: paletteToColorscale(activeBathyPalette) as any,
          lighting: {
            ambient: 0.8,
            diffuse: 0.35,
            specular: 0.05,
            roughness: 0.95,
          } as any,
          contours: {
            z: {
              show: showContours,
              highlight: showContours,
              usecolormap: false,
              color: "rgba(255,255,255,0.10)",
              highlightcolor: "limegreen",
              project: { z: false },
            },
          } as any,
          showscale: false,
          opacity: bathyOpacity,
        });
      }
    }

    if (
      overlayEnabled &&
      overlayMode === "surface"
    ) {
      const zPlane = numericH?.zPlane ?? 0;
      const zPlanePlot = scaleZ(zPlane);
      const FIELD_CONTOUR_EPS_M = 2;

      // Prefer plotting numeric fields on their native lon/lat grid to avoid mismatches
      // between the model grid and the bathymetry grid near coasts/land.
      const plane = (() => {
        if (numericH?.values) {
          const values = numericH.values;
          const ny = values.length;
          const nx = values[0]?.length ?? 0;
          if (
            Array.isArray(numericH.lon) &&
            Array.isArray(numericH.lat) &&
            numericH.lon.length === nx &&
            numericH.lat.length === ny
          ) {
            return {
              x: numericH.lon,
              y: numericH.lat,
              values,
              bounds: numericH.bounds,
              zeroAsMissing: Boolean(numericH.zeroAsMissing),
              maskDryByBathy: numericH.maskDryByBathy !== false,
            };
          }
          // Fallback: if already bathy-shaped, plot directly.
          if (ny === bathy.lat.length && nx === bathy.lon.length) {
            return {
              x: bathy.lon,
              y: bathy.lat,
              values,
              bounds: numericH.bounds,
              zeroAsMissing: Boolean(numericH.zeroAsMissing),
              maskDryByBathy: numericH.maskDryByBathy !== false,
            };
          }
          // Last resort: use the resampled overlaySurfacecolor on the bathy grid.
          return {
            x: bathy.lon,
            y: bathy.lat,
            values: (overlaySurfacecolor as any) ?? values,
            bounds: numericH.bounds,
            zeroAsMissing: Boolean(numericH.zeroAsMissing),
            maskDryByBathy: numericH.maskDryByBathy !== false,
          };
        }
        return {
          x: bathy.lon,
          y: bathy.lat,
          values: overlaySurfacecolor as any,
          bounds: props.horizontalOverlay?.bounds,
          zeroAsMissing: false,
          maskDryByBathy: false,
        };
      })();

      const lonMap =
        plane.maskDryByBathy
          ? plane.x.map((xv) => {
              let best = 0;
              let bestD = Infinity;
              for (let i = 0; i < bathy.lon.length; i++) {
                const d = Math.abs(bathy.lon[i] - xv);
                if (d < bestD) {
                  bestD = d;
                  best = i;
                }
              }
              return best;
            })
          : null;
      const latMap =
        plane.maskDryByBathy
          ? plane.y.map((yv) => {
              let best = 0;
              let bestD = Infinity;
              for (let j = 0; j < bathy.lat.length; j++) {
                const d = Math.abs(bathy.lat[j] - yv);
                if (d < bestD) {
                  bestD = d;
                  best = j;
                }
              }
              return best;
            })
          : null;

      const valuesMasked: number[][] = plane.values.map((row, j) =>
        row.map((v, i) => {
          const val = Number(v);
          if (!Number.isFinite(val)) return Number.NaN;
          if (plane.zeroAsMissing && val === 0) return Number.NaN;

          // For fields where 0 can be physically valid (e.g., temperature), only treat
          // exact-zero values as potential fill and mask them on dry cells. Do not mask
          // non-zero values with bathymetry to avoid coastal false positives.
          const maybeFill = val === 0;
          if (bathyHasOceanNeg && maybeFill && lonMap && latMap) {
            const jj = latMap[j];
            const ii = lonMap[i];
            const depth = Number(bathy.z[jj]?.[ii]);
            if (Number.isFinite(depth) && depth >= -1e-6) return Number.NaN;
          }

          if (plane.bounds) {
            const { lonMin, lonMax, latMin, latMax } = plane.bounds;
            const lon = plane.x[i];
            const lat = plane.y[j];
            const inside =
              lon >= Math.min(lonMin, lonMax) &&
              lon <= Math.max(lonMin, lonMax) &&
              lat >= Math.min(latMin, latMax) &&
              lat <= Math.max(latMin, latMax);
            if (!inside) return Number.NaN;
          }

          return val;
        })
      );
      const hoverValues: number[][] = valuesMasked.map((row, j) =>
        row.map((masked, i) => {
          if (Number.isFinite(masked)) return masked;
          const raw = Number(plane.values?.[j]?.[i]);
          if (!Number.isFinite(raw)) return Number.NaN;
          // Keep land masked in hover readout, but avoid NaN in ocean where the
          // visualized field is valid.
          if (lonMap && latMap) {
            const jj = latMap[j];
            const ii = lonMap[i];
            const depth = Number(bathy.z[jj]?.[ii]);
            if (Number.isFinite(depth) && depth >= -1e-6) return Number.NaN;
          }
          return raw;
        })
      );
      const hoverText: string[][] = hoverValues.map((row, j) =>
        row.map((v, i) => {
          const valueText = Number.isFinite(v) ? Number(v).toFixed(3) : "n/a";
          return (
            `Lon ${Number(plane.x[i]).toFixed(2)}°<br>` +
            `Lat ${Number(plane.y[j]).toFixed(2)}°<br>` +
            `${overlayColorbarTitle}: ${valueText}`
          );
        })
      );

      const zSheet = valuesMasked.map((row) =>
        row.map((val) => {
          if (!Number.isFinite(val)) return Number.NaN;
          if (!showFieldContours) return zPlanePlot;
          const t = (val - overlayCmin) / Math.max(1e-9, overlayCmax - overlayCmin);
          const bump = FIELD_CONTOUR_EPS_M * Math.max(0, Math.min(1, t));
          return zPlanePlot + bump;
        })
      );
      traces.push({
        type: "surface",
        name: "Overlay (surface)",
        x: plane.x,
        y: plane.y,
        z: zSheet,
        surfacecolor: valuesMasked as any,
        hovertext: hoverText as any,
        cmin: overlayCmin,
        cmax: overlayCmax,
        cauto: false,
        colorscale: overlayColorscale as any,
        showscale: showOverlayScale,
        ...(showOverlayScale
          ? {
              colorbar: {
                ...makeColorbarConfig({
                  title: overlayColorbarTitle,
                  tickvals: overlayColorbarTicks,
                  len: overlayColorbarLen,
                  x: overlayColorbarX,
                  y: overlayColorbarY,
                }),
              } as any,
            }
          : null),
        opacity: overlayOpacity,
        lighting: { ambient: 1.0, diffuse: 0.15, specular: 0.0, roughness: 1.0 } as any,
        flatshading: true as any,
        ...(showFieldContours
          ? {
              contours: {
                z: {
                  show: true,
                  highlight: true,
                  usecolormap: false,
                  color: "rgba(255,255,255,0.22)",
                  highlightcolor: "rgba(255,255,255,0.40)",
                  start: zPlanePlot,
                  end: zPlanePlot + FIELD_CONTOUR_EPS_M,
                  size: Math.max(0.05, FIELD_CONTOUR_EPS_M / 12),
                  project: { z: false },
                },
              } as any,
            }
          : null),
        hoverinfo: "text",
      });
    }

    // Extra planes (stacked depth slices, sea ice concentration, etc).
    const planes = (props.horizontalPlanes ?? []).filter((p) => p?.enabled);
    for (let idx = 0; idx < planes.length; idx++) {
      const p = planes[idx];
      const { x, y, values } = fieldGridForPlane(p);
      const zPlane = p.zPlane ?? 0;
      const zPlanePlot = scaleZ(zPlane);
      const zSheet = y.map((_, j) =>
        x.map((_, i) => {
          const v = values?.[j]?.[i];
          return v === undefined || !Number.isFinite(Number(v)) ? Number.NaN : zPlanePlot;
        })
      );
      const opacity = p.opacity ?? 0.25;
      const showScale = Boolean(p.showScale);
      const hoverText: string[][] = values.map((row, j) =>
        row.map((v, i) => {
          const n = Number(v);
          const valueText = Number.isFinite(n) ? n.toFixed(3) : "n/a";
          return (
            `Lon ${Number(x[i]).toFixed(2)}°<br>` +
            `Lat ${Number(y[j]).toFixed(2)}°<br>` +
            `${p.colorbarTitle ?? "Value"}: ${valueText}`
          );
        })
      );
      traces.push({
        type: "surface",
        name: `Plane ${idx + 1}`,
        x,
        y,
        z: zSheet as any,
        surfacecolor: values as any,
        hovertext: hoverText as any,
        cmin: p.cmin,
        cmax: p.cmax,
        cauto: false,
        colorscale: p.colorscale as any,
        showscale: showScale,
        ...(showScale
          ? {
              colorbar: {
                ...makeColorbarConfig({
                  title: p.colorbarTitle ?? "Value",
                  tickvals: p.colorbarTicks,
                  len: p.colorbarLen,
                  x: p.colorbarX,
                  y: p.colorbarY,
                }),
              } as any,
            }
          : null),
        opacity,
        lighting: { ambient: 1.0, diffuse: 0.15, specular: 0.0, roughness: 1.0 } as any,
        flatshading: true as any,
        ...(p.hoverSkip
          ? { hoverinfo: "skip" as const }
          : {
              hoverinfo: "text" as const,
            }),
      });
    }

    if (props.classLayer?.enabled && Array.isArray(props.classLayer.points)) {
      const markerSize = Math.max(1, Number(props.classLayer.markerSize ?? 2.4));
      const opacity = Math.max(0.1, Math.min(1, Number(props.classLayer.opacity ?? 0.7)));
      const showLegend = props.classLayer.showLegend !== false;
      const legendMarkerSize = Math.max(7, markerSize + 3.5);
      const showScale = props.classLayer.showScale !== false;
      if (showScale && props.classLayer.points.length) {
        const colorValues = props.classLayer.points
          .map((p) => Number(p.value))
          .filter((v) => Number.isFinite(v));
        if (colorValues.length) {
          traces.push({
            type: "scatter3d",
            mode: "markers",
            name: "Class colorbar",
            x: colorValues.map(() => Number.NaN) as any,
            y: colorValues.map(() => Number.NaN) as any,
            z: colorValues.map(() => Number.NaN) as any,
            marker: {
              size: 1,
              color: colorValues as any,
              cmin: props.classLayer.cmin,
              cmax: props.classLayer.cmax,
              cauto: false,
              colorscale: props.classLayer.colorscale as any,
              showscale: true,
              colorbar: {
                ...makeColorbarConfig({
                  title: props.classLayer.colorbarTitle ?? props.classLayer.varLabel ?? "Class",
                  tickvals: props.classLayer.colorbarTicks,
                  ticktext: props.classLayer.colorbarTickText,
                  len: props.classLayer.colorbarLen,
                  x: props.classLayer.colorbarX,
                  y: props.classLayer.colorbarY,
                }),
              } as any,
              opacity: 0,
            } as any,
            showlegend: false,
            hoverinfo: "skip",
          });
        }
      }
      for (let idx = 0; idx < props.classLayer.points.length; idx++) {
        const cls = props.classLayer.points[idx];
        if (!Array.isArray(cls.x) || !Array.isArray(cls.y) || !Array.isArray(cls.z)) continue;
        if (!cls.x.length || cls.x.length !== cls.y.length || cls.x.length !== cls.z.length) continue;
        const zPlot = cls.z.map((zv) => scaleZ(Number(zv)));
        const customDepth = cls.z.map((zv) => Number(zv));
        const classColor = colorFromColorscale(
          Number(cls.value),
          props.classLayer.cmin,
          props.classLayer.cmax,
          props.classLayer.colorscale
        );
        const classLabel = cls.label || `${cls.value}`;
        if (showLegend) {
          traces.push({
            type: "scatter3d",
            mode: "markers",
            name: `${classLabel} class`,
            x: [Number.NaN] as any,
            y: [Number.NaN] as any,
            z: [Number.NaN] as any,
            marker: {
              size: legendMarkerSize,
              color: classColor,
              opacity: 1,
            } as any,
            showlegend: true,
            hoverinfo: "skip",
          });
        }
        traces.push({
          type: "scatter3d",
          mode: "markers",
          name: `${classLabel} class`,
          x: cls.x as any,
          y: cls.y as any,
          z: zPlot as any,
          customdata: customDepth as any,
          marker: {
            size: markerSize,
            color: classColor,
            opacity,
          } as any,
          showlegend: false,
          hovertemplate:
            `Class: ${classLabel}<br>` +
            `Lon %{x:.2f}°<br>` +
            `Lat %{y:.2f}°<br>` +
            `Depth %{customdata:.0f} m<extra></extra>`,
        });
      }
    }

    if (props.eddyLayer?.enabled && Array.isArray(props.eddyLayer.clusters)) {
      const markerSize = Math.max(1.5, Number(props.eddyLayer.markerSize ?? 3));
      const opacity = Math.max(0.15, Math.min(1, Number(props.eddyLayer.opacity ?? 0.9)));
      const trackOpacity = Math.max(0.15, Math.min(1, Number(props.eddyLayer.trackOpacity ?? 0.8)));
      const showLegend = props.eddyLayer.showLegend !== false;
      const warmColor = "rgba(255,132,88,0.96)";
      const coldColor = "rgba(88,170,255,0.96)";

      if (showLegend) {
        traces.push({
          type: "scatter3d",
          mode: "markers",
          name: "Warm eddies",
          x: [Number.NaN] as any,
          y: [Number.NaN] as any,
          z: [Number.NaN] as any,
          marker: { size: markerSize + 1.5, color: warmColor, opacity: 1 } as any,
          hoverinfo: "skip",
          showlegend: true,
        });
        traces.push({
          type: "scatter3d",
          mode: "markers",
          name: "Cold eddies",
          x: [Number.NaN] as any,
          y: [Number.NaN] as any,
          z: [Number.NaN] as any,
          marker: { size: markerSize + 1.5, color: coldColor, opacity: 1 } as any,
          hoverinfo: "skip",
          showlegend: true,
        });
      }

      for (let idx = 0; idx < props.eddyLayer.clusters.length; idx++) {
        const cluster = props.eddyLayer.clusters[idx];
        const color = cluster.kind === "warm" ? warmColor : coldColor;
        const zPlot = cluster.z.map((zv) => scaleZ(Number(zv)));
        const text = cluster.x.map(() => cluster.hoverText);

        if (
          Array.isArray(cluster.trackX) &&
          Array.isArray(cluster.trackY) &&
          Array.isArray(cluster.trackZ) &&
          cluster.trackX.length > 1 &&
          cluster.trackX.length === cluster.trackY.length &&
          cluster.trackX.length === cluster.trackZ.length
        ) {
          traces.push({
            type: "scatter3d",
            mode: "lines",
            name: `${cluster.kind} eddy track`,
            x: cluster.trackX as any,
            y: cluster.trackY as any,
            z: cluster.trackZ.map((zv) => scaleZ(Number(zv))) as any,
            line: { width: 5, color } as any,
            opacity: trackOpacity,
            hoverinfo: "skip",
            showlegend: false,
          });
        }

        traces.push({
          type: "scatter3d",
          mode: "markers",
          name: `${cluster.kind} eddy`,
          x: cluster.x as any,
          y: cluster.y as any,
          z: zPlot as any,
          text: text as any,
          marker: {
            size: markerSize,
            color,
            opacity,
          } as any,
          showlegend: false,
          hovertemplate: "%{text}<extra></extra>",
        });
      }
    }

    const guidePath = props.guidePath?.enabled ? props.guidePath : null;
    if (guidePath?.lon.length && guidePath.lat.length === guidePath.lon.length) {
      const zGuide = scaleZ(Number.isFinite(Number(guidePath.zPlane)) ? Number(guidePath.zPlane) : 8);
      const color = guidePath.color ?? "rgba(99,220,255,0.96)";
      traces.push({
        type: "scatter3d",
        mode: guidePath.lon.length > 1 ? "lines+markers" : "markers",
        name: guidePath.name ?? "Guide path",
        x: guidePath.lon as any,
        y: guidePath.lat as any,
        z: guidePath.lon.map(() => zGuide) as any,
        line: { width: Math.max(3, Number(guidePath.width ?? 6)), color } as any,
        marker: {
          size: Math.max(4, Number(guidePath.markerSize ?? 5)),
          color,
          opacity: Math.max(0.2, Math.min(1, Number(guidePath.opacity ?? 0.95))),
        } as any,
        hoverinfo: "skip",
        showlegend: false,
      });
    }

    const numericT = props.transectField?.enabled ? props.transectField : null;
    if (numericT) {
      const zScaled = numericT.z.map((zv) => scaleZ(zv));
      const latPath = Array.isArray(numericT.lat) ? numericT.lat : numericT.lon.map(() => numericT.lat);
      const xCurtain = numericT.z.map(() => numericT.lon.slice());
      const yCurtain = numericT.z.map(() => latPath.slice());
      const bathyLonIdx = numericT.lon.map((xv) => {
        let best = 0;
        let bestD = Math.abs(Number(bathy.lon[0]) - Number(xv));
        for (let i = 1; i < bathy.lon.length; i++) {
          const d = Math.abs(Number(bathy.lon[i]) - Number(xv));
          if (d < bestD) {
            best = i;
            bestD = d;
          }
        }
        return best;
      });
      const bathyLatIdx = latPath.map((yv) => {
        let best = 0;
        let bestD = Math.abs(Number(bathy.lat[0]) - Number(yv));
        for (let j = 1; j < bathy.lat.length; j++) {
          const d = Math.abs(Number(bathy.lat[j]) - Number(yv));
          if (d < bestD) {
            best = j;
            bestD = d;
          }
        }
        return best;
      });
      const bottomByPoint = bathyLonIdx.map((i, pointIndex) => Number(bathy.z[bathyLatIdx[pointIndex]]?.[i]));
      const valuesMasked = numericT.values.map((row, j) => {
        const depth = Number(numericT.z[j]);
        return row.map((val, i) => {
          const n = Number(val);
          if (!Number.isFinite(n)) return Number.NaN;
          const bottom = Number(bottomByPoint[i]);
          if (Number.isFinite(bottom)) {
            if (bottom >= -1e-6) return Number.NaN;
            if (Number.isFinite(depth) && depth < bottom - 1e-6) return Number.NaN;
          }
          return n;
        });
      });
      const zCurtain = zScaled.map((zv, j) =>
        numericT.lon.map((_, i) => (Number.isFinite(valuesMasked[j]?.[i]) ? zv : Number.NaN))
      );
      const transectHoverText = valuesMasked.map((row, j) =>
        row.map((val, i) => {
          const n = Number(val);
          const vText = Number.isFinite(n) ? n.toFixed(3) : "n/a";
          const distanceText =
            Number.isFinite(Number(numericT.distanceKm?.[i])) ? `<br>Distance ${Number(numericT.distanceKm?.[i]).toFixed(0)} km` : "";
          return (
            `Lon ${Number(numericT.lon[i]).toFixed(2)}°<br>` +
            `Lat ${Number(latPath[i]).toFixed(2)}°` +
            distanceText +
            `<br>` +
            `Depth ${Number(numericT.z[j]).toFixed(0)} m<br>` +
            `${numericT.colorbarTitle ?? "Value"}: ${vText}`
          );
        })
      );
      const opacity = numericT.opacity ?? 0.9;
      traces.push({
        type: "surface",
        name: "Zonal",
        x: xCurtain as any,
        y: yCurtain as any,
        z: zCurtain as any,
        surfacecolor: valuesMasked as any,
        hovertext: transectHoverText as any,
        cmin: numericT.cmin,
        cmax: numericT.cmax,
        cauto: false,
        colorscale: numericT.colorscale as any,
        showscale: Boolean(numericT.showScale),
        ...(numericT.showScale
          ? {
              colorbar: {
                ...makeColorbarConfig({
                  title: numericT.colorbarTitle ?? "Value",
                  tickvals: numericT.colorbarTicks,
                  len: numericT.colorbarLen,
                  x: numericT.colorbarX,
                  y: numericT.colorbarY,
                }),
              } as any,
            }
          : null),
        opacity,
        hoverinfo: "text",
      });
    } else if (props.transectOverlay?.enabled && transectCurtain) {
      const opacity = props.transectOverlay.opacity ?? 0.9;
      const zScaled = transectCurtain.z.map((row) => row.map((v) => (Number.isFinite(v) ? scaleZ(v) : v)));
      traces.push({
        type: "surface",
        x: transectCurtain.x,
        y: transectCurtain.y,
        z: zScaled as any,
        surfacecolor: transectCurtain.surfacecolor as any,
        cmin: 0,
        cmax: 255,
        cauto: false,
        colorscale: colorscale332 as any,
        showscale: false,
        opacity,
        hoverinfo: "skip",
      });
    }

    return traces;
  }, [
    bathy,
    bathyZPlot,
    horizontalColor,
    props.horizontalField,
    props.horizontalPlanes,
    props.horizontalOverlay?.enabled,
    props.horizontalOverlay?.showScale,
    props.horizontalOverlay?.mode,
    props.horizontalOverlay?.opacity,
    props.showBathy,
    props.guidePath,
    props.transectField,
    props.transectOverlay?.enabled,
    props.transectOverlay?.opacity,
    props.windLayer,
    props.classLayer,
    props.eddyLayer,
    activeBathyPalette,
    props.bathyOpacity,
    props.showBathyContours,
    props.showFieldContours,
    scaleZ,
    transectCurtain,
  ]);

  const maxOverlayPlaneZForRange = useMemo(() => {
    let maxOverlayPlaneZ = STABLE_SCENE_OVERLAY_Z_MAX_M;
    const horizontalFieldPlane = Number(props.horizontalField?.zPlane);
    if (Number.isFinite(horizontalFieldPlane)) {
      maxOverlayPlaneZ = Math.max(maxOverlayPlaneZ, horizontalFieldPlane);
    }
    const planes = props.horizontalPlanes ?? [];
    for (let i = 0; i < planes.length; i++) {
      const plane = planes[i];
      const planeZ = Number(plane.zPlane);
      if (Number.isFinite(planeZ)) maxOverlayPlaneZ = Math.max(maxOverlayPlaneZ, planeZ);
    }
    const windPlaneZ = Number(props.windLayer?.zPlane);
    if (Number.isFinite(windPlaneZ)) {
      maxOverlayPlaneZ = Math.max(maxOverlayPlaneZ, windPlaneZ);
    }
    const eddyLayer = props.eddyLayer;
    if (eddyLayer?.enabled && Array.isArray(eddyLayer.clusters)) {
      for (let i = 0; i < eddyLayer.clusters.length; i++) {
        const cluster = eddyLayer.clusters[i];
        const points = [...(cluster.z ?? []), ...(cluster.trackZ ?? [])];
        for (let k = 0; k < points.length; k++) {
          const z = Number(points[k]);
          if (Number.isFinite(z)) maxOverlayPlaneZ = Math.max(maxOverlayPlaneZ, z);
        }
      }
    }
    return maxOverlayPlaneZ;
  }, [
    props.horizontalField?.zPlane,
    props.horizontalPlanes,
    props.windLayer?.zPlane,
    props.eddyLayer,
  ]);

  const fixedRanges = useMemo(() => {
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < bathy.lon.length; i++) {
      const v = Number(bathy.lon[i]);
      if (!Number.isFinite(v)) continue;
      xMin = Math.min(xMin, v);
      xMax = Math.max(xMax, v);
    }
    for (let j = 0; j < bathy.lat.length; j++) {
      const v = Number(bathy.lat[j]);
      if (!Number.isFinite(v)) continue;
      yMin = Math.min(yMin, v);
      yMax = Math.max(yMax, v);
    }

    if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) {
      xMin = -30;
      xMax = 23;
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = 57.670002;
      yMax = 81.49752;
    }

    let zMin = Infinity;
    let zMax = 0;
    for (let j = 0; j < bathyZPlot.length; j++) {
      const row = bathyZPlot[j] as any;
      if (!Array.isArray(row)) continue;
      for (let i = 0; i < row.length; i++) {
        const v = Number(row[i]);
        if (!Number.isFinite(v)) continue;
        zMin = Math.min(zMin, v);
        zMax = Math.max(zMax, v);
      }
    }
    if (!Number.isFinite(zMin)) zMin = scaleZ(-5000);

    // Keep enough headroom above sea level for stacked translucent planes
    // (surface field, sea ice, wind) to avoid WebGL z-fighting/banding.
    zMax = Math.max(zMax, scaleZ(maxOverlayPlaneZForRange + 30));

    return {
      x: [Math.min(xMin, xMax), Math.max(xMin, xMax)] as [number, number],
      y: [Math.min(yMin, yMax), Math.max(yMin, yMax)] as [number, number],
      z: [zMin, zMax] as [number, number],
    };
  }, [
    bathy.lat,
    bathy.lon,
    bathyZPlot,
    maxOverlayPlaneZForRange,
    scaleZ,
  ]);

  const depthRatio = useMemo(() => {
    const v = Number(props.depthRatio);
    if (!Number.isFinite(v) || v <= 0) return 0.35;
    return Math.max(0.05, Math.min(3, v));
  }, [props.depthRatio]);
  const compactLayout = Boolean(props.compactLayout);
  const layout = useMemo<Partial<Layout>>(
    () => ({
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: "rgba(0,0,0,0)",
      showlegend: true,
      legend: {
        x: compactLayout ? 0.70 : 0.9,
        y: 0.98,
        xanchor: "left",
        yanchor: "top",
        bgcolor: "rgba(8,16,32,0.58)",
        bordercolor: "rgba(255,255,255,0.20)",
        borderwidth: 1,
        font: { size: compactLayout ? 12 : 15 },
      } as any,
      // Preserve user camera/zoom across updates (e.g., SST animation frames).
      uirevision: "keep",
      scene: {
        // Preserve 3D camera across updates while animating.
        uirevision: "keep",
        domain: compactLayout ? { x: [0, 1], y: [0, 1] } : { x: [0.24, 1], y: [0, 1] },
        xaxis: { title: "Longitude", showgrid: false, zeroline: false, range: fixedRanges.x as any },
        yaxis: { title: "Latitude", showgrid: false, zeroline: false, range: fixedRanges.y as any },
        zaxis: {
          title: "Depth (m)",
          showgrid: false,
          zeroline: false,
          tickmode: "array",
          tickvals: zAxisTicks.tickvals as any,
          ticktext: zAxisTicks.ticktext as any,
          range: fixedRanges.z as any,
        },
        dragmode: "orbit",
        aspectmode: "manual",
        aspectratio: { x: 1.1, y: 1.0, z: depthRatio },
      }
    }),
    [
      compactLayout,
      depthRatio,
      fixedRanges.x,
      fixedRanges.y,
      fixedRanges.z,
      zAxisTicks.ticktext,
      zAxisTicks.tickvals,
    ]
  );

  const plotConfig = useMemo(
    () => ({
      displayModeBar: false,
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
    }),
    []
  );

  const handleInitialized = useCallback((_: any, graphDiv: any) => {
    if (didInitCameraRef.current) return;
    didInitCameraRef.current = true;
    const Plotly = plotlyLibRef.current;
    if (!Plotly || !graphDiv) return;
    if (graphDivRef.current !== graphDiv) {
      graphDivRef.current = graphDiv;
      setGraphDivVersion((n) => n + 1);
    } else {
      graphDivRef.current = graphDiv;
    }
    // Set a good initial view once; after that, user interactions are preserved via uirevision.
    try {
      const cam = initialCameraRef.current ?? DEFAULT_SCENE_CAMERA;
      lastKnownCameraRef.current = cam;
      void Plotly.relayout(graphDiv, { "scene.camera": cam });
      // Persist the initial camera once so revisiting the page keeps the same view,
      // even if the user doesn't touch the scene.
      try {
        const existing = window.localStorage.getItem(SCENE_CAMERA_STORAGE_KEY);
        if (!existing) window.localStorage.setItem(SCENE_CAMERA_STORAGE_KEY, JSON.stringify(cam));
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  }, []);

  const handleUpdate = useCallback((_: any, graphDiv: any) => {
    if (graphDiv) {
      const changed = graphDivRef.current !== graphDiv;
      graphDivRef.current = graphDiv;
      if (changed) setGraphDivVersion((n) => n + 1);
    }
    const cam = normalizeCamera(graphDiv?.layout?.scene?.camera);
    if (cam && !lastKnownCameraRef.current) lastKnownCameraRef.current = cam;
  }, []);

  useEffect(() => {
    if (props.cameraResetNonce == null) return;
    const Plotly = plotlyLibRef.current;
    const graphDiv = graphDivRef.current;
    if (!Plotly || !graphDiv) return;
    try {
      const cam = DEFAULT_SCENE_CAMERA;
      initialCameraRef.current = cam;
      lastKnownCameraRef.current = cam;
      lastSavedCameraJsonRef.current = null;
      void Plotly.relayout(graphDiv, { "scene.camera": cam });
      try {
        window.localStorage.setItem(SCENE_CAMERA_STORAGE_KEY, JSON.stringify(cam));
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  }, [props.cameraResetNonce]);

  useEffect(() => {
    const focus = props.cameraFocusPath;
    if (!focus || !Number.isFinite(Number(focus.nonce))) return;
    if (lastCameraFocusNonceRef.current === focus.nonce) return;

    const Plotly = plotlyLibRef.current;
    const graphDiv = graphDivRef.current;
    if (!Plotly || !graphDiv || !didInitCameraRef.current) return;
    lastCameraFocusNonceRef.current = focus.nonce;

    const cam = cameraFacingTransect({
      lon: focus.lon,
      lat: focus.lat,
      xRange: fixedRanges.x,
      yRange: fixedRanges.y,
      baseCamera:
        lastKnownCameraRef.current ??
        normalizeCamera(graphDiv?.layout?.scene?.camera) ??
        initialCameraRef.current ??
        DEFAULT_SCENE_CAMERA,
    });
    if (!cam) return;

    lastKnownCameraRef.current = cam;
    skipNextCameraPersistRef.current = true;
    try {
      void Plotly.relayout(graphDiv, { "scene.camera": cam });
    } catch {
      skipNextCameraPersistRef.current = false;
    }
  }, [fixedRanges.x, fixedRanges.y, graphDivVersion, props.cameraFocusPath]);

  const handleRelayout = useCallback((event: any, graphDivMaybe: any) => {
    const graphDiv = graphDivMaybe ?? graphDivRef.current;
    if (!graphDiv) return;

    // Try to read the full current camera from graphDiv (more robust than piecing from relayout keys).
    const cam = normalizeCamera(graphDiv?.layout?.scene?.camera);
    if (!cam) return;
    lastKnownCameraRef.current = cam;
    if (skipNextCameraPersistRef.current) {
      skipNextCameraPersistRef.current = false;
      return;
    }

    // Debounce writes to localStorage to avoid excessive churn while orbiting.
    if (saveRafRef.current != null) window.cancelAnimationFrame(saveRafRef.current);
    saveRafRef.current = window.requestAnimationFrame(() => {
      saveRafRef.current = null;
      try {
        const json = JSON.stringify(cam);
        if (json === lastSavedCameraJsonRef.current) return;
        lastSavedCameraJsonRef.current = json;
        window.localStorage.setItem(SCENE_CAMERA_STORAGE_KEY, json);
      } catch {
        // ignore
      }
    });
  }, []);
  const handleRelayouting = useCallback((event: any, graphDivMaybe: any) => {
    const graphDiv = graphDivMaybe ?? graphDivRef.current;
    if (graphDiv) graphDivRef.current = graphDiv;
    const cam = normalizeCamera(graphDiv?.layout?.scene?.camera);
    if (cam) lastKnownCameraRef.current = cam;
  }, []);

  const handleClick = useCallback(
    (event: any) => {
      if (!props.onSurfacePick) return;
      const pick = extractSurfacePick(event) ?? lastSurfaceHoverPickRef.current;
      if (!pick) return;
      props.onSurfacePick(pick);
    },
    [props.onSurfacePick]
  );

  const handleHover = useCallback(
    (event: any) => {
      if (!props.onSurfaceHover) return;
      const pick = extractSurfacePick(event);
      if (!pick) return;
      lastSurfaceHoverPickRef.current = pick;
      props.onSurfaceHover(pick);
    },
    [props.onSurfaceHover]
  );

  const handleUnhover = useCallback(() => {
    // Plotly fires unhover while crossing from the surface to the temporary guide
    // line. Keep the last valid surface pick until the pointer truly leaves the plot.
  }, []);

  useEffect(() => {
    const graphDiv = graphDivRef.current;
    if (!graphDiv) return;

    const clearHover = () => {
      lastSurfaceHoverPickRef.current = null;
      props.onSurfaceHover?.(null);
    };

    const handlePointerDown = (event: PointerEvent) => {
      pointerDownRef.current = { x: event.clientX, y: event.clientY, moved: false };
    };

    const handlePointerMove = (event: PointerEvent) => {
      const state = pointerDownRef.current;
      if (!state) return;
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) > 6) {
        state.moved = true;
      }
    };

    const handlePointerUp = () => {
      const state = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!props.onSurfacePick || !state || state.moved) return;
      const pick = lastSurfaceHoverPickRef.current;
      if (pick) props.onSurfacePick(pick);
    };

    graphDiv.addEventListener("pointerleave", clearHover);
    graphDiv.addEventListener("pointerdown", handlePointerDown, true);
    graphDiv.addEventListener("pointermove", handlePointerMove, true);
    graphDiv.addEventListener("pointerup", handlePointerUp, true);
    return () => {
      graphDiv.removeEventListener("pointerleave", clearHover);
      graphDiv.removeEventListener("pointerdown", handlePointerDown, true);
      graphDiv.removeEventListener("pointermove", handlePointerMove, true);
      graphDiv.removeEventListener("pointerup", handlePointerUp, true);
    };
  }, [graphDivVersion, props.onSurfaceHover, props.onSurfacePick]);

  useEffect(() => {
    // Keep the current camera orientation while changing data mode/layout/scaling controls.
    const Plotly = plotlyLibRef.current;
    const graphDiv = graphDivRef.current;
    if (!Plotly || !graphDiv || !didInitCameraRef.current) return;
    const cam =
      lastKnownCameraRef.current ??
      normalizeCamera(graphDiv?.layout?.scene?.camera) ??
      initialCameraRef.current ??
      DEFAULT_SCENE_CAMERA;
    if (!cam) return;
    lastKnownCameraRef.current = cam;
    let raf = window.requestAnimationFrame(() => {
      raf = 0;
      try {
        const currentSig = cameraSignature(graphDiv?.layout?.scene?.camera);
        const targetSig = cameraSignature(cam);
        if (currentSig && targetSig && currentSig === targetSig) return;
        void Plotly.relayout(graphDiv, { "scene.camera": cam });
      } catch {
        // ignore
      }
    });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [
    compactLayout,
    depthRatio,
    depthWarp.deepRatio,
    depthWarp.focusDepthM,
    depthWarp.mode,
    graphDivVersion,
    fixedRanges.x,
    fixedRanges.y,
    fixedRanges.z,
  ]);

  if (!Plot) {
    return (
      <div
        className="basemap"
        style={{
          background:
            "radial-gradient(1000px 800px at 55% 20%, rgba(103,232,249,0.18) 0%, rgba(167,139,250,0.10) 25%, rgba(0,0,0,0) 55%)",
        }}
      >
        {plotStatus === "loading" ? (
          <div
            style={{
              position: "absolute",
              left: 12,
              bottom: 12,
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.25)",
              color: "rgba(255,255,255,0.72)",
              fontSize: 12,
            }}
          >
            Loading 3D bathymetry…
          </div>
        ) : null}
        {plotStatus === "failed" ? (
          <div
            style={{
              position: "absolute",
              left: 12,
              bottom: 12,
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.35)",
              color: "rgba(255,255,255,0.78)",
              fontSize: 12,
              maxWidth: 520,
            }}
          >
            Plotly failed to load. Open DevTools Console to see the error.
            {typeof location !== "undefined" && location.protocol === "file:" ? (
              <div style={{ marginTop: 6 }}>
                Tip: use <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace" }}>npm start</span> or{" "}
                <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace" }}>npm run preview</span> (fetch is blocked on file://).
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="basemap">
      <Plot
        data={data as PlotData[]}
        layout={layout as Layout}
        config={plotConfig}
        onInitialized={handleInitialized}
        onUpdate={handleUpdate}
        onRelayouting={handleRelayouting as any}
        onRelayout={handleRelayout as any}
        onHover={handleHover as any}
        onUnhover={handleUnhover as any}
        onClick={handleClick as any}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler
      />
      <canvas
        ref={windCanvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 2,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
