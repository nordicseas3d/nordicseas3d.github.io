import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { withBase } from "../lib/paths";
import { makeSyntheticGreenlandSeaBathy } from "../lib/syntheticBathy";
import { bathyCandidates, loadBathyGridFromCandidates, type BathyGrid as SharedBathyGrid } from "../lib/bathyJson";
import { formatColorbarTick, formatColorbarTickText } from "../lib/colorbar";
import type { RGB } from "../lib/colormap";

type BathyGrid = SharedBathyGrid;

type HorizontalField = {
  enabled: boolean;
  values: number[][];
  lon?: number[];
  lat?: number[];
  cmin: number;
  cmax: number;
  colorscale: Array<[number, string]>;
  opacity?: number;
  mode?: "surface" | "bathy";
  zPlane?: number;
  showScale?: boolean;
  colorbarTitle?: string;
  colorbarTicks?: number[];
  colorbarTickText?: string[];
  colorbarLen?: number;
  colorbarX?: number;
  colorbarY?: number;
  hoverSkip?: boolean;
  bounds?: {
    lonMin: number;
    lonMax: number;
    latMin: number;
    latMax: number;
  };
  zeroAsMissing?: boolean;
  maskDryByBathy?: boolean;
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
  renderStyle?: "points" | "voxels";
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

type IsoSurfaceLayer = {
  enabled: boolean;
  lon: number[];
  lat: number[];
  depth: number[][];
  value: number[][];
  cmin: number;
  cmax: number;
  colorscale: Array<[number, string]>;
  opacity?: number;
  showScale?: boolean;
  colorbarTitle?: string;
  colorbarTicks?: number[];
  colorbarTickText?: string[];
  colorbarLen?: number;
  colorbarX?: number;
  colorbarY?: number;
  valueTitle?: string;
};

type IsoVolumeBodiesLayer = {
  enabled: boolean;
  lon: number[];
  lat: number[];
  interfaceDepth: number[][];
  shallowColor: string;
  deepColor: string;
  opacity?: number;
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
  sampleStride?: number;
  zoomAdaptive?: boolean;
};

type MeshFrame = {
  width: number;
  height: number;
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
};

type ColorscaleStop = {
  t: number;
  color: THREE.Color;
};

type ColorbarViewModel = {
  id: string;
  title: string;
  gradient: string;
  min: number;
  max: number;
  ticks: number[];
  tickText?: string[];
  len: number;
};

type WindParticle = {
  x: number;
  y: number;
  ttl: number;
  speed: number;
  trail: Array<{ x: number; y: number; speed: number }>;
};

const TARGET_VERTICES_MODEL = 90000;
const TARGET_VERTICES_RTOPO = 70000;
const TARGET_FIELD_VERTICES = 70000;
const BASE_MESH_WIDTH = 360;
const BASE_Z_SCALE = 0.035;
const DEFAULT_NORTHWARD_CAMERA_DIRECTION = new THREE.Vector3(0.0, -0.88, 0.72);

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

async function tryLoadBathyJson(
  bathySource?: "model" | "rtopo"
): Promise<{ grid: BathyGrid; source: "file" | "synthetic" }> {
  const effective = bathySource ?? "model";
  const candidates = bathyCandidates();
  const urls =
    effective === "rtopo"
      ? [candidates.rtopo, candidates.legacyRTopo, candidates.legacyRTopoDs, candidates.model, candidates.legacyNordic]
      : [candidates.model, candidates.legacyNordic, candidates.legacyGreenlandSea, candidates.legacyBathy, candidates.rtopo];
  const payload = await loadBathyGridFromCandidates(urls);
  if (payload) {
    const zNumeric = payload.z.map((row) => row.map((v) => Number(v)));
    let hasNeg = false;
    let hasPos = false;
    outer: for (let j = 0; j < zNumeric.length; j += 1) {
      const row = zNumeric[j];
      for (let i = 0; i < row.length; i += 1) {
        const v = Number(row[i]);
        if (!Number.isFinite(v) || v === 0) continue;
        if (v < 0) hasNeg = true;
        if (v > 0) hasPos = true;
        if (hasNeg && hasPos) break outer;
      }
    }
    if (!hasNeg && hasPos) {
      for (let j = 0; j < zNumeric.length; j += 1) {
        const row = zNumeric[j];
        for (let i = 0; i < row.length; i += 1) row[i] = -row[i];
      }
    }
    const zRaw = zNumeric;
    const zGeom = zRaw.map((row) => row.map((v) => (Number.isFinite(v) ? v : Number.NaN)));
    return {
      grid: {
        lon: payload.lon.map((v) => Number(v)),
        lat: payload.lat.map((v) => Number(v)),
        z: zGeom,
        zRaw,
      },
      source: "file",
    };
  }

  return { grid: makeSyntheticGreenlandSeaBathy(), source: "synthetic" };
}

function pickStride(nx: number, ny: number, maxVertices: number) {
  let stride = 1;
  while (Math.ceil(nx / stride) * Math.ceil(ny / stride) > maxVertices && stride < Math.max(nx, ny)) {
    stride += 1;
  }
  return stride;
}

function buildSampleIndices(length: number, stride: number) {
  const out: number[] = [];
  for (let i = 0; i < length; i += stride) out.push(i);
  if (!out.length || out[out.length - 1] !== length - 1) out.push(length - 1);
  return out;
}

function downsampleGrid(grid: BathyGrid, maxVertices: number): BathyGrid {
  const nx = grid.lon.length;
  const ny = grid.lat.length;
  if (nx < 2 || ny < 2) return grid;
  const stride = pickStride(nx, ny, maxVertices);
  if (stride <= 1) return grid;
  const xIdx = buildSampleIndices(nx, stride);
  const yIdx = buildSampleIndices(ny, stride);
  const lon = xIdx.map((i) => Number(grid.lon[i]));
  const lat = yIdx.map((j) => Number(grid.lat[j]));
  const z = yIdx.map((j) => xIdx.map((i) => Number(grid.z[j]?.[i])));
  const zRaw = grid.zRaw ? yIdx.map((j) => xIdx.map((i) => Number(grid.zRaw?.[j]?.[i]))) : undefined;
  return { lon, lat, z, zRaw };
}

function parseCssColor(css: string) {
  try {
    return new THREE.Color(css);
  } catch {
    return new THREE.Color("#ffffff");
  }
}

function toColorscaleStops(scale: Array<[number, string]>) {
  const out: ColorscaleStop[] = scale
    .map(([t, color]) => ({ t: Number(t), color: parseCssColor(color) }))
    .filter((entry) => Number.isFinite(entry.t));
  out.sort((a, b) => a.t - b.t);
  if (!out.length) {
    out.push({ t: 0, color: new THREE.Color("#ffffff") }, { t: 1, color: new THREE.Color("#ffffff") });
  }
  if (out[0].t > 0) out.unshift({ t: 0, color: out[0].color.clone() });
  if (out[out.length - 1].t < 1) out.push({ t: 1, color: out[out.length - 1].color.clone() });
  return out;
}

function colorFromPalette(palette: RGB[], t: number) {
  const safeT = clamp(t, 0, 1);
  if (!palette.length) return new THREE.Color("#808080");
  const idx = Math.max(0, Math.min(palette.length - 1, Math.round(safeT * (palette.length - 1))));
  const c = palette[idx];
  return new THREE.Color(c.r / 255, c.g / 255, c.b / 255);
}

function colorFromScaleStops(stops: ColorscaleStop[], t: number) {
  const safeT = clamp(t, 0, 1);
  if (safeT <= stops[0].t) return stops[0].color;
  for (let i = 1; i < stops.length; i += 1) {
    const a = stops[i - 1];
    const b = stops[i];
    if (safeT <= b.t) {
      const span = Math.max(1e-9, b.t - a.t);
      const local = clamp((safeT - a.t) / span, 0, 1);
      return a.color.clone().lerp(b.color, local);
    }
  }
  return stops[stops.length - 1].color;
}

function colorscaleToCssGradient(colorscale: Array<[number, string]>) {
  const stops = colorscale
    .map(([t, color]) => ({ t: Number(t), color }))
    .filter((entry) => Number.isFinite(entry.t))
    .sort((a, b) => a.t - b.t);
  if (!stops.length) {
    return "linear-gradient(to top, #0b132a 0%, #dbeafe 100%)";
  }
  const clamped = stops.map((s) => ({ t: clamp(s.t, 0, 1), color: s.color }));
  if (clamped[0].t > 0) clamped.unshift({ t: 0, color: clamped[0].color });
  if (clamped[clamped.length - 1].t < 1) clamped.push({ t: 1, color: clamped[clamped.length - 1].color });
  const parts = clamped.map((s) => `${s.color} ${(s.t * 100).toFixed(2)}%`);
  return `linear-gradient(to top, ${parts.join(", ")})`;
}

function paletteToCssGradient(palette: RGB[]) {
  if (!palette.length) return "linear-gradient(to top, #0b132a 0%, #dbeafe 100%)";
  const denom = Math.max(1, palette.length - 1);
  const parts = palette.map((c, i) => {
    const pct = (i / denom) * 100;
    return `rgb(${c.r},${c.g},${c.b}) ${pct.toFixed(2)}%`;
  });
  return `linear-gradient(to top, ${parts.join(", ")})`;
}

function makeAutoTicks(min: number, max: number, count = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min, max].filter((v) => Number.isFinite(v));
  const out: number[] = [];
  const n = Math.max(2, count);
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    out.push(min + (max - min) * t);
  }
  return out;
}

function makeLinearAxis(min: number, max: number, count: number) {
  if (count <= 1 || !Number.isFinite(min) || !Number.isFinite(max)) return [min];
  const out = new Array<number>(count);
  const span = max - min;
  for (let i = 0; i < count; i += 1) {
    out[i] = min + (span * i) / (count - 1);
  }
  return out;
}

function nearestIndexSorted(values: number[], target: number) {
  if (!values.length || !Number.isFinite(target)) return -1;
  if (target <= values[0]) return 0;
  const last = values.length - 1;
  if (target >= values[last]) return last;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= target) lo = mid;
    else hi = mid;
  }
  return target - values[lo] <= values[hi] - target ? lo : hi;
}

function makeBathymetryTicks(min: number, max: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const span = max - min;
  const rawStep = Math.abs(span) / 4;
  const exponent = Math.floor(Math.log10(Math.max(rawStep, 1e-9)));
  const fraction = rawStep / 10 ** exponent;
  const niceFraction = fraction <= 1.5 ? 1 : fraction <= 3 ? 2 : fraction <= 4.5 ? 2.5 : fraction <= 7 ? 5 : 10;
  const step = niceFraction * 10 ** exponent;
  const start = Math.ceil(min / step) * step;
  const end = Math.floor(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 0.25; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }
  if (ticks.length < 2) {
    return [Number(min.toFixed(0)), Number(max.toFixed(0))].filter((v, i, arr) => arr.indexOf(v) === i);
  }
  return ticks;
}

function disposeObject(object: THREE.Object3D | null) {
  if (!object) return;
  object.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    const geometry = (mesh as { geometry?: THREE.BufferGeometry }).geometry;
    const material = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
    if (geometry) geometry.dispose();
    if (Array.isArray(material)) material.forEach((entry) => entry?.dispose?.());
    else material?.dispose?.();
  });
}

function buildScalarPlaneMesh(opts: {
  field: HorizontalField;
  frame: MeshFrame;
  meshLon: number[];
  meshLat: number[];
  meshDepth: number[][];
  verticalScale: number;
  maxVertices?: number;
}): THREE.Mesh | null {
  const { field, frame, meshLon, meshLat, meshDepth, verticalScale, maxVertices = TARGET_FIELD_VERTICES } = opts;
  const values = field.values;
  const nyFull = values.length;
  const nxFull = Array.isArray(values[0]) ? values[0].length : 0;
  if (nyFull < 2 || nxFull < 2) return null;

  const fieldLonAxis =
    field.lon && field.lon.length === nxFull
      ? field.lon.map((v) => Number(v))
      : makeLinearAxis(frame.lonMin, frame.lonMax, nxFull);
  const fieldLatAxis =
    field.lat && field.lat.length === nyFull
      ? field.lat.map((v) => Number(v))
      : makeLinearAxis(frame.latMin, frame.latMax, nyFull);
  if (fieldLonAxis.length < 2 || fieldLatAxis.length < 2) return null;
  if (meshLon.length < 2 || meshLat.length < 2) return null;

  const cmin = Number(field.cmin);
  const cmax = Number(field.cmax);
  if (!Number.isFinite(cmin) || !Number.isFinite(cmax) || cmax <= cmin) return null;
  const stops = toColorscaleStops(field.colorscale);
  const zPlane = Number.isFinite(field.zPlane) ? Number(field.zPlane) : 0;
  const opacity = clamp(Number(field.opacity ?? 0.9), 0, 1);
  const lonSpan = Math.max(1e-9, frame.lonMax - frame.lonMin);
  const latSpan = Math.max(1e-9, frame.latMax - frame.latMin);

  const stride = pickStride(meshLon.length, meshLat.length, maxVertices);
  const xIdx = buildSampleIndices(meshLon.length, stride);
  const yIdx = buildSampleIndices(meshLat.length, stride);
  const fieldLonIdx = xIdx.map((i) => nearestIndexSorted(fieldLonAxis, Number(meshLon[i])));
  const fieldLatIdx = yIdx.map((j) => nearestIndexSorted(fieldLatAxis, Number(meshLat[j])));

  const positions: number[] = [];
  const colors: number[] = [];
  const invalidValue = (v: number) =>
    !Number.isFinite(v) || (field.zeroAsMissing && Math.abs(v) < 1e-12);
  const toX = (lon: number) => ((lon - frame.lonMin) / lonSpan - 0.5) * frame.width;
  const toY = (lat: number) => ((lat - frame.latMin) / latSpan - 0.5) * frame.height;
  const toColor = (v: number) =>
    colorFromScaleStops(stops, clamp((v - cmin) / Math.max(1e-9, cmax - cmin), 0, 1));

  for (let j = 0; j < yIdx.length - 1; j += 1) {
    const j0 = yIdx[j];
    const j1 = yIdx[j + 1];
    const sj0 = fieldLatIdx[j];
    const sj1 = fieldLatIdx[j + 1];
    if (sj0 < 0 || sj1 < 0) continue;
    for (let i = 0; i < xIdx.length - 1; i += 1) {
      const i0 = xIdx[i];
      const i1 = xIdx[i + 1];
      const si0 = fieldLonIdx[i];
      const si1 = fieldLonIdx[i + 1];
      if (si0 < 0 || si1 < 0) continue;
      const v00 = Number(values[sj0]?.[si0]);
      const v10 = Number(values[sj0]?.[si1]);
      const v01 = Number(values[sj1]?.[si0]);
      const v11 = Number(values[sj1]?.[si1]);
      const d00 = Number(meshDepth[j0]?.[i0]);
      const d10 = Number(meshDepth[j0]?.[i1]);
      const d01 = Number(meshDepth[j1]?.[i0]);
      const d11 = Number(meshDepth[j1]?.[i1]);
      const dryThreshold = -5;
      const dryMasked =
        field.maskDryByBathy &&
        (!Number.isFinite(d00) ||
          !Number.isFinite(d10) ||
          !Number.isFinite(d01) ||
          !Number.isFinite(d11) ||
          d00 >= dryThreshold ||
          d10 >= dryThreshold ||
          d01 >= dryThreshold ||
          d11 >= dryThreshold);
      if (invalidValue(v00) || invalidValue(v10) || invalidValue(v01) || invalidValue(v11)) {
        continue;
      }
      if (dryMasked) continue;

      const x00 = toX(Number(meshLon[i0]));
      const x10 = toX(Number(meshLon[i1]));
      const x01 = x00;
      const x11 = x10;
      const y00 = toY(Number(meshLat[j0]));
      const y10 = y00;
      const y01 = toY(Number(meshLat[j1]));
      const y11 = y01;
      const c00 = toColor(v00);
      const c10 = toColor(v10);
      const c01 = toColor(v01);
      const c11 = toColor(v11);

      positions.push(x00, y00, zPlane, x10, y10, zPlane, x01, y01, zPlane);
      colors.push(c00.r, c00.g, c00.b, c10.r, c10.g, c10.b, c01.r, c01.g, c01.b);
      positions.push(x10, y10, zPlane, x11, y11, zPlane, x01, y01, zPlane);
      colors.push(c10.r, c10.g, c10.b, c11.r, c11.g, c11.b, c01.r, c01.g, c01.b);
    }
  }

  if (positions.length < 9) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const overlay = new THREE.Mesh(geometry, material);
  overlay.scale.z = verticalScale;
  overlay.renderOrder = 5;
  return overlay;
}

function buildIsoDepthMesh(opts: {
  layer: IsoSurfaceLayer;
  frame: MeshFrame;
  verticalScale: number;
  maxVertices?: number;
}): THREE.Mesh | null {
  const { layer, frame, verticalScale, maxVertices = TARGET_FIELD_VERTICES } = opts;
  const nyFull = layer.depth.length;
  const nxFull = Array.isArray(layer.depth[0]) ? layer.depth[0].length : 0;
  if (nyFull < 2 || nxFull < 2) return null;
  if (layer.lon.length !== nxFull || layer.lat.length !== nyFull) return null;
  const cmin = Number(layer.cmin);
  const cmax = Number(layer.cmax);
  if (!Number.isFinite(cmin) || !Number.isFinite(cmax) || cmax <= cmin) return null;
  const stops = toColorscaleStops(layer.colorscale);
  const opacity = clamp(Number(layer.opacity ?? 0.7), 0, 1);
  const lonSpan = Math.max(1e-9, frame.lonMax - frame.lonMin);
  const latSpan = Math.max(1e-9, frame.latMax - frame.latMin);

  const stride = pickStride(layer.lon.length, layer.lat.length, maxVertices);
  const xIdx = buildSampleIndices(layer.lon.length, stride);
  const yIdx = buildSampleIndices(layer.lat.length, stride);

  const positions: number[] = [];
  const colors: number[] = [];
  const toX = (lon: number) => ((lon - frame.lonMin) / lonSpan - 0.5) * frame.width;
  const toY = (lat: number) => ((lat - frame.latMin) / latSpan - 0.5) * frame.height;
  const toColor = (depth: number) =>
    colorFromScaleStops(stops, clamp((depth - cmin) / Math.max(1e-9, cmax - cmin), 0, 1));

  for (let j = 0; j < yIdx.length - 1; j += 1) {
    const j0 = yIdx[j];
    const j1 = yIdx[j + 1];
    for (let i = 0; i < xIdx.length - 1; i += 1) {
      const i0 = xIdx[i];
      const i1 = xIdx[i + 1];
      const d00 = Number(layer.depth[j0]?.[i0]);
      const d10 = Number(layer.depth[j0]?.[i1]);
      const d01 = Number(layer.depth[j1]?.[i0]);
      const d11 = Number(layer.depth[j1]?.[i1]);
      if (!Number.isFinite(d00) || !Number.isFinite(d10) || !Number.isFinite(d01) || !Number.isFinite(d11)) continue;

      const x00 = toX(Number(layer.lon[i0]));
      const x10 = toX(Number(layer.lon[i1]));
      const x01 = x00;
      const x11 = x10;
      const y00 = toY(Number(layer.lat[j0]));
      const y10 = y00;
      const y01 = toY(Number(layer.lat[j1]));
      const y11 = y01;
      const c00 = toColor(d00);
      const c10 = toColor(d10);
      const c01 = toColor(d01);
      const c11 = toColor(d11);

      positions.push(x00, y00, d00, x10, y10, d10, x01, y01, d01);
      colors.push(c00.r, c00.g, c00.b, c10.r, c10.g, c10.b, c01.r, c01.g, c01.b);
      positions.push(x10, y10, d10, x11, y11, d11, x01, y01, d01);
      colors.push(c10.r, c10.g, c10.b, c11.r, c11.g, c11.b, c01.r, c01.g, c01.b);
    }
  }

  if (positions.length < 9) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity,
    roughness: 0.92,
    metalness: 0.04,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.z = verticalScale;
  mesh.renderOrder = 7;
  return mesh;
}

function buildClassPointsObject(opts: {
  layer: ClassLayer;
  frame: MeshFrame;
  verticalScale: number;
}): THREE.Points | null {
  const { layer, frame, verticalScale } = opts;
  const lonSpan = Math.max(1e-9, frame.lonMax - frame.lonMin);
  const latSpan = Math.max(1e-9, frame.latMax - frame.latMin);
  const toX = (lon: number) => ((lon - frame.lonMin) / lonSpan - 0.5) * frame.width;
  const toY = (lat: number) => ((lat - frame.latMin) / latSpan - 0.5) * frame.height;
  const stops = toColorscaleStops(layer.colorscale);
  const cmin = Number(layer.cmin);
  const cmax = Number(layer.cmax);
  const positions: number[] = [];
  const colors: number[] = [];

  for (const trace of layer.points ?? []) {
    if (!Array.isArray(trace.x) || !Array.isArray(trace.y) || !Array.isArray(trace.z)) continue;
    const color = colorFromScaleStops(
      stops,
      clamp((Number(trace.value) - cmin) / Math.max(1e-9, cmax - cmin), 0, 1)
    );
    const count = Math.min(trace.x.length, trace.y.length, trace.z.length);
    for (let i = 0; i < count; i += 1) {
      const lon = Number(trace.x[i]);
      const lat = Number(trace.y[i]);
      const depth = Number(trace.z[i]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(depth)) continue;
      positions.push(toX(lon), toY(lat), depth);
      colors.push(color.r, color.g, color.b);
    }
  }

  if (positions.length < 3) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  const material = new THREE.PointsMaterial({
    size: Math.max(1.5, Number(layer.markerSize ?? 2.6)),
    vertexColors: true,
    transparent: true,
    opacity: clamp(Number(layer.opacity ?? 0.72), 0.1, 1),
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.scale.z = verticalScale;
  points.renderOrder = 8;
  return points;
}

function estimateAverageSpacing(values: number[]) {
  if (values.length < 2) return Number.NaN;
  const unique = Array.from(new Set(values.map((v) => Number(v.toFixed(6))))).sort((a, b) => a - b);
  if (unique.length < 2) return Number.NaN;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < unique.length; i += 1) {
    const diff = unique[i] - unique[i - 1];
    if (!Number.isFinite(diff) || diff <= 0) continue;
    sum += diff;
    count += 1;
  }
  return count > 0 ? sum / count : Number.NaN;
}

function buildClassVoxelObject(opts: {
  layer: ClassLayer;
  frame: MeshFrame;
  verticalScale: number;
}): THREE.Object3D | null {
  const { layer, frame, verticalScale } = opts;
  const lonValues: number[] = [];
  const latValues: number[] = [];
  const depthValues: number[] = [];
  let totalCount = 0;

  for (const trace of layer.points ?? []) {
    const count = Math.min(trace.x.length, trace.y.length, trace.z.length);
    totalCount += count;
    for (let i = 0; i < count; i += 1) {
      const lon = Number(trace.x[i]);
      const lat = Number(trace.y[i]);
      const depth = Number(trace.z[i]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(depth)) continue;
      lonValues.push(lon);
      latValues.push(lat);
      depthValues.push(depth);
    }
  }

  if (!totalCount || !lonValues.length || !latValues.length || !depthValues.length) return null;

  const lonSpan = Math.max(1e-9, frame.lonMax - frame.lonMin);
  const latSpan = Math.max(1e-9, frame.latMax - frame.latMin);
  const lonSpacing = estimateAverageSpacing(lonValues);
  const latSpacing = estimateAverageSpacing(latValues);
  const depthSpacing = estimateAverageSpacing(depthValues.map((v) => Math.abs(v)));
  const sizeX = Math.max(0.8, (Number.isFinite(lonSpacing) ? (lonSpacing / lonSpan) * frame.width : frame.width / 70) * 0.9);
  const sizeY = Math.max(0.8, (Number.isFinite(latSpacing) ? (latSpacing / latSpan) * frame.height : frame.height / 70) * 0.9);
  const sizeZ = Math.max(18, (Number.isFinite(depthSpacing) ? depthSpacing : 140) * 0.9);
  const toX = (lon: number) => ((lon - frame.lonMin) / lonSpan - 0.5) * frame.width;
  const toY = (lat: number) => ((lat - frame.latMin) / latSpan - 0.5) * frame.height;
  const stops = toColorscaleStops(layer.colorscale);
  const cmin = Number(layer.cmin);
  const cmax = Number(layer.cmax);

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    transparent: true,
    opacity: clamp(Number(layer.opacity ?? 0.36), 0.08, 0.95),
    roughness: 0.88,
    metalness: 0.02,
    depthWrite: false,
    vertexColors: true,
  });
  const voxels = new THREE.InstancedMesh(geometry, material, totalCount);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(sizeX, sizeY, sizeZ);
  const quaternion = new THREE.Quaternion();
  let instanceIndex = 0;

  for (const trace of layer.points ?? []) {
    if (!Array.isArray(trace.x) || !Array.isArray(trace.y) || !Array.isArray(trace.z)) continue;
    const color = colorFromScaleStops(
      stops,
      clamp((Number(trace.value) - cmin) / Math.max(1e-9, cmax - cmin), 0, 1)
    );
    const count = Math.min(trace.x.length, trace.y.length, trace.z.length);
    for (let i = 0; i < count; i += 1) {
      const lon = Number(trace.x[i]);
      const lat = Number(trace.y[i]);
      const depth = Number(trace.z[i]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(depth)) continue;
      position.set(toX(lon), toY(lat), depth);
      matrix.compose(position, quaternion, scale);
      voxels.setMatrixAt(instanceIndex, matrix);
      voxels.setColorAt(instanceIndex, color);
      instanceIndex += 1;
    }
  }

  if (!instanceIndex) {
    geometry.dispose();
    material.dispose();
    return null;
  }

  voxels.count = instanceIndex;
  voxels.instanceMatrix.needsUpdate = true;
  if (voxels.instanceColor) voxels.instanceColor.needsUpdate = true;
  voxels.scale.z = verticalScale;
  voxels.renderOrder = 8;
  return voxels;
}

function buildIsoVolumeBodiesObject(opts: {
  layer: IsoVolumeBodiesLayer;
  frame: MeshFrame;
  verticalScale: number;
  bathyLon: number[];
  bathyLat: number[];
  bathyDepth: number[][];
}): THREE.Object3D | null {
  const { layer, frame, verticalScale, bathyLon, bathyLat, bathyDepth } = opts;
  const ny = layer.interfaceDepth.length;
  const nx = Array.isArray(layer.interfaceDepth[0]) ? layer.interfaceDepth[0].length : 0;
  if (ny < 2 || nx < 2 || layer.lon.length !== nx || layer.lat.length !== ny) return null;

  const lonSpan = Math.max(1e-9, frame.lonMax - frame.lonMin);
  const latSpan = Math.max(1e-9, frame.latMax - frame.latMin);
  const toX = (lon: number) => ((lon - frame.lonMin) / lonSpan - 0.5) * frame.width;
  const toY = (lat: number) => ((lat - frame.latMin) / latSpan - 0.5) * frame.height;
  const shallowColor = parseCssColor(layer.shallowColor);
  const deepColor = parseCssColor(layer.deepColor);
  const opacity = clamp(Number(layer.opacity ?? 0.34), 0.08, 0.95);
  const maxCells = (nx - 1) * (ny - 1) * 2;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, maxCells);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  let instanceIndex = 0;
  const surfaceZ = 0;
  const minThickness = 20;
  const insetFactor = 0.92;

  for (let j = 0; j < ny - 1; j += 1) {
    const lat0 = Number(layer.lat[j]);
    const lat1 = Number(layer.lat[j + 1]);
    if (!Number.isFinite(lat0) || !Number.isFinite(lat1)) continue;
    for (let i = 0; i < nx - 1; i += 1) {
      const lon0 = Number(layer.lon[i]);
      const lon1 = Number(layer.lon[i + 1]);
      if (!Number.isFinite(lon0) || !Number.isFinite(lon1)) continue;
      const d00 = Number(layer.interfaceDepth[j]?.[i]);
      const d10 = Number(layer.interfaceDepth[j]?.[i + 1]);
      const d01 = Number(layer.interfaceDepth[j + 1]?.[i]);
      const d11 = Number(layer.interfaceDepth[j + 1]?.[i + 1]);
      if (!Number.isFinite(d00) || !Number.isFinite(d10) || !Number.isFinite(d01) || !Number.isFinite(d11)) continue;

      const lonCenter = (lon0 + lon1) * 0.5;
      const latCenter = (lat0 + lat1) * 0.5;
      const bathyI = nearestIndexSorted(bathyLon, lonCenter);
      const bathyJ = nearestIndexSorted(bathyLat, latCenter);
      const bottom = Number(bathyDepth[bathyJ]?.[bathyI]);
      if (!Number.isFinite(bottom) || bottom > -5) continue;

      const interfaceDepth = (d00 + d10 + d01 + d11) * 0.25;
      if (!Number.isFinite(interfaceDepth) || interfaceDepth >= -minThickness) continue;

      const width = Math.abs(toX(lon1) - toX(lon0)) * insetFactor;
      const height = Math.abs(toY(lat1) - toY(lat0)) * insetFactor;
      if (width <= 0 || height <= 0) continue;

      const addBox = (top: number, base: number, color: THREE.Color) => {
        const thickness = Math.abs(top - base);
        if (!Number.isFinite(thickness) || thickness < minThickness) return;
        position.set(toX(lonCenter), toY(latCenter), (top + base) * 0.5);
        scale.set(width, height, thickness);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(instanceIndex, matrix);
        mesh.setColorAt(instanceIndex, color);
        instanceIndex += 1;
      };

      addBox(surfaceZ, interfaceDepth, shallowColor);
      if (bottom < interfaceDepth - minThickness) addBox(interfaceDepth, bottom, deepColor);
    }
  }

  if (!instanceIndex) {
    geometry.dispose();
    material.dispose();
    return null;
  }

  mesh.count = instanceIndex;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.scale.z = verticalScale;
  mesh.renderOrder = 8;
  return mesh;
}

export default function BasemapThree(props: {
  bathySource?: "model" | "rtopo";
  bathyPalette?: RGB[];
  bathyOpacity?: number;
  bathyColorbar?: {
    enabled: boolean;
    title?: string;
    subtitle?: string;
    tickvals?: number[];
    len?: number;
    x?: number;
    y?: number;
  };
  compactLayout?: boolean;
  depthRatio?: number;
  themeMode?: "day" | "night";
  showBathy?: boolean;
  horizontalField?: HorizontalField;
  horizontalPlanes?: HorizontalField[];
  classLayer?: ClassLayer;
  isoVolumeBodiesLayer?: IsoVolumeBodiesLayer;
  isoSurfaceLayer?: IsoSurfaceLayer;
  windLayer?: WindLayer;
  currentLayers?: WindLayer[];
  currentsColorbar?: {
    title: string;
    colorscale: any;
    cmin: number;
    cmax: number;
    ticks: number[];
    tickText: string[];
    len?: number;
  };
  guidePath?: GuidePath;
  onSurfacePick?: (pick: { lon: number; lat: number }) => void;
  onSurfaceHover?: (pick: { lon: number; lat: number } | null) => void;
  drawingMode?: boolean;
  viewerHint?: string;
  onStatusChange?: (status: {
    plotly: "loading" | "ready" | "failed";
    bathy: "loading" | "file" | "synthetic";
    horizontalImage: "off" | "loading" | "ready" | "failed";
    transectImage: "off" | "loading" | "ready" | "failed";
  }) => void;
  cameraResetNonce?: number;
  cameraAutoFitKey?: string | number;
  fitReservedLeftPx?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const hemiLightRef = useRef<THREE.HemisphereLight | null>(null);
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const fillLightRef = useRef<THREE.DirectionalLight | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const overlayRef = useRef<THREE.Mesh | null>(null);
  const overlayPlanesRef = useRef<THREE.Group | null>(null);
  const classPointsRef = useRef<THREE.Object3D | null>(null);
  const isoVolumeBodiesRef = useRef<THREE.Object3D | null>(null);
  const isoSurfaceRef = useRef<THREE.Mesh | null>(null);
  const guideRef = useRef<THREE.Object3D | null>(null);
  const windCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const windRafRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());
  const meshFrameRef = useRef<MeshFrame | null>(null);
  const meshAxesRef = useRef<{ lon: number[]; lat: number[] } | null>(null);
  const meshDepthRef = useRef<number[][] | null>(null);
  const domainFitRef = useRef<{ center: THREE.Vector3; radius: number } | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onSurfaceHoverRef = useRef(props.onSurfaceHover);
  const onSurfacePickRef = useRef(props.onSurfacePick);
  const didSetInitialTargetRef = useRef(false);
  const windParticlesRef = useRef<WindParticle[]>([]);
  const fitRetryRafRef = useRef<number | null>(null);
  const fitRetryTimeoutsRef = useRef<number[]>([]);

  const [grid, setGrid] = useState<BathyGrid | null>(null);
  const [bathyStatus, setBathyStatus] = useState<"loading" | "file" | "synthetic">("loading");
  const [runtimeStatus, setRuntimeStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [bathyRange, setBathyRange] = useState<{ min: number; max: number } | null>(null);
  const [meshFrameNonce, setMeshFrameNonce] = useState(0);

  const bathyPalette = props.bathyPalette ?? [];
  const verticalScale = BASE_Z_SCALE * clamp(Number(props.depthRatio ?? 0.5), 0.1, 2.5);

  const fitCameraToDomain = useCallback((force = false) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const fit = domainFitRef.current;
    if (!camera || !controls || !fit) return;

    const center = fit.center;
    const domainRadius = fit.radius;
    const hostWidth = Math.max(1, containerRef.current?.clientWidth ?? 1);
    const reservedLeftRatio = clamp((props.fitReservedLeftPx ?? 0) / hostWidth, 0, 0.42);
    const frameTarget = center
      .clone()
      .add(new THREE.Vector3(-domainRadius * (0.035 + reservedLeftRatio * 0.9), 0, 0));

    camera.updateMatrixWorld();
    const targetDist = controls.target.distanceTo(frameTarget);
    const camDist = camera.position.distanceTo(center);
    const ndc = center.clone().project(camera);
    const centerOffViewport =
      !Number.isFinite(ndc.x) ||
      !Number.isFinite(ndc.y) ||
      !Number.isFinite(ndc.z) ||
      Math.abs(ndc.x) > 0.35 ||
      Math.abs(ndc.y) > 0.35 ||
      ndc.z < -1 ||
      ndc.z > 1;
    const shouldRecenter =
      force ||
      !Number.isFinite(targetDist) ||
      !Number.isFinite(camDist) ||
      centerOffViewport ||
      targetDist > domainRadius * 0.2 ||
      camDist > domainRadius * 10 ||
      camDist < domainRadius * 0.15;
    if (!shouldRecenter) return;

    let direction = camera.position.clone().sub(controls.target);
    if (force || direction.lengthSq() < 1e-8) {
      direction.copy(DEFAULT_NORTHWARD_CAMERA_DIRECTION);
    }
    direction.normalize();

    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const hFovRad = 2 * Math.atan(Math.tan(fovRad * 0.5) * Math.max(1e-4, camera.aspect || 1));
    const fitDist = Math.max(
      domainRadius / Math.max(1e-4, Math.sin(fovRad * 0.5)),
      domainRadius / Math.max(1e-4, Math.sin(hFovRad * 0.5))
    );
    const currentDist = camera.position.distanceTo(controls.target);
    const safeDist = force
      ? fitDist * 0.80
      : clamp(
          Number.isFinite(currentDist) ? currentDist : fitDist,
          fitDist * 0.90,
          fitDist * 3.2
        );

    controls.target.copy(frameTarget);
    camera.position.copy(frameTarget.clone().addScaledVector(direction, safeDist));
    camera.lookAt(frameTarget);
    camera.updateMatrixWorld(true);
    controls.update();
    didSetInitialTargetRef.current = true;
  }, [props.fitReservedLeftPx]);

  const isDayTheme = props.themeMode === "day";

  const cancelScheduledFits = useCallback(() => {
    if (fitRetryRafRef.current != null) {
      window.cancelAnimationFrame(fitRetryRafRef.current);
      fitRetryRafRef.current = null;
    }
    if (fitRetryTimeoutsRef.current.length) {
      fitRetryTimeoutsRef.current.forEach((id) => window.clearTimeout(id));
      fitRetryTimeoutsRef.current = [];
    }
  }, []);

  const scheduleStabilizedFit = useCallback((force = true) => {
    cancelScheduledFits();
    fitCameraToDomain(force);
    fitRetryRafRef.current = window.requestAnimationFrame(() => {
      fitCameraToDomain(force);
      fitRetryRafRef.current = window.requestAnimationFrame(() => {
        fitCameraToDomain(force);
        fitRetryRafRef.current = null;
      });
    });
    [120, 280, 520, 900, 1500].forEach((delayMs) => {
      const id = window.setTimeout(() => fitCameraToDomain(force), delayMs);
      fitRetryTimeoutsRef.current.push(id);
    });
  }, [cancelScheduledFits, fitCameraToDomain]);

  useEffect(() => {
    onSurfaceHoverRef.current = props.onSurfaceHover;
  }, [props.onSurfaceHover]);

  useEffect(() => {
    onSurfacePickRef.current = props.onSurfacePick;
  }, [props.onSurfacePick]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.enabled = !props.drawingMode;
    controls.update();
  }, [props.drawingMode]);

  useEffect(() => {
    let cancelled = false;
    setBathyStatus("loading");
    setRuntimeStatus("loading");
    void tryLoadBathyJson(props.bathySource)
      .then(({ grid: loaded, source }) => {
        if (cancelled) return;
        setGrid(loaded);
        setBathyStatus(source);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("Failed to load bathymetry for Three.js renderer", error);
        setRuntimeStatus("failed");
        setRuntimeError(
          error instanceof Error ? error.message : "Three.js failed to load bathymetry."
        );
      });
    return () => {
      cancelled = true;
    };
  }, [props.bathySource]);

  useEffect(() => {
    props.onStatusChange?.({
      plotly: runtimeStatus,
      bathy: bathyStatus,
      horizontalImage: "off",
      transectImage: "off",
    });
  }, [bathyStatus, props.onStatusChange, runtimeStatus]);

  const pickFromClient = useMemo(
    () => (clientX: number, clientY: number): { lon: number; lat: number } | null => {
      const renderer = rendererRef.current;
      const camera = cameraRef.current;
      const mesh = meshRef.current;
      const frame = meshFrameRef.current;
      if (!renderer || !camera || !mesh || !frame) return null;
      const canvas = renderer.domElement;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      pointerRef.current.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(pointerRef.current, camera);
      const hits = raycasterRef.current.intersectObject(mesh, false);
      if (!hits.length) return null;
      const local = hits[0].point.clone();
      mesh.worldToLocal(local);
      const u = (local.x + frame.width / 2) / frame.width;
      const v = (local.y + frame.height / 2) / frame.height;
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      return {
        lon: frame.lonMin + u * (frame.lonMax - frame.lonMin),
        lat: frame.latMin + v * (frame.latMax - frame.latMin),
      };
    },
    []
  );

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    try {
      const scene = new THREE.Scene();
      sceneRef.current = scene;

      const camera = new THREE.PerspectiveCamera(42, 1, 1, 45000);
      camera.up.set(0, 0, 1);
      camera.position.set(-180, -250, 190);
      cameraRef.current = camera;

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setClearColor(0x000000, 0);
      Object.assign(renderer.domElement.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        display: "block",
      });
      rendererRef.current = renderer;
      host.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.85;
      controls.zoomSpeed = 0.9;
      controls.panSpeed = 0.85;
      controls.screenSpacePanning = true;
      controls.target.set(0, 0, -35);
      controls.update();
      controlsRef.current = controls;

      const hemi = new THREE.HemisphereLight(0xf1f5f9, 0x1f2937, 0.85);
      hemi.position.set(0, 0, 1);
      scene.add(hemi);
      hemiLightRef.current = hemi;

      const key = new THREE.DirectionalLight(0xffffff, 1.0);
      key.position.set(-220, -260, 380);
      scene.add(key);
      keyLightRef.current = key;

      const fill = new THREE.DirectionalLight(0x93c5fd, 0.38);
      fill.position.set(280, 180, 120);
      scene.add(fill);
      fillLightRef.current = fill;

      const resize = () => {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);

        fitCameraToDomain(false);
      };
      resize();

      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resizeObserverRef.current = observer;

      const onWindowFit = () => {
        scheduleStabilizedFit(true);
      };
      window.addEventListener("load", onWindowFit);
      window.addEventListener("pageshow", onWindowFit);
      window.addEventListener("resize", onWindowFit);
      window.visualViewport?.addEventListener("resize", onWindowFit);
      window.visualViewport?.addEventListener("scroll", onWindowFit);

      const animate = () => {
        animationRef.current = window.requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
      };
      animate();

      const onPointerMove = (event: PointerEvent) => {
        const down = pointerDownRef.current;
        if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) {
          down.moved = true;
        }
        if (!onSurfaceHoverRef.current) return;
        onSurfaceHoverRef.current(pickFromClient(event.clientX, event.clientY));
      };
      const onPointerLeave = () => {
        pointerDownRef.current = null;
        onSurfaceHoverRef.current?.(null);
      };
      const onPointerDown = (event: PointerEvent) => {
        pointerDownRef.current = { x: event.clientX, y: event.clientY, moved: false };
      };
      const onPointerUp = (event: PointerEvent) => {
        const down = pointerDownRef.current;
        pointerDownRef.current = null;
        if (!down || down.moved) return;
        const pick = pickFromClient(event.clientX, event.clientY);
        if (pick) onSurfacePickRef.current?.(pick);
      };

      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerleave", onPointerLeave);
      renderer.domElement.addEventListener("pointerdown", onPointerDown, true);
      renderer.domElement.addEventListener("pointerup", onPointerUp, true);

      setRuntimeStatus("ready");
      setRuntimeError(null);

      return () => {
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
        renderer.domElement.removeEventListener("pointerdown", onPointerDown, true);
        renderer.domElement.removeEventListener("pointerup", onPointerUp, true);
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        if (animationRef.current) {
          window.cancelAnimationFrame(animationRef.current);
          animationRef.current = null;
        }
        if (windRafRef.current != null) {
          window.cancelAnimationFrame(windRafRef.current);
          windRafRef.current = null;
        }
        cancelScheduledFits();
        window.removeEventListener("load", onWindowFit);
        window.removeEventListener("pageshow", onWindowFit);
        window.removeEventListener("resize", onWindowFit);
        window.visualViewport?.removeEventListener("resize", onWindowFit);
        window.visualViewport?.removeEventListener("scroll", onWindowFit);
        windParticlesRef.current = [];
        const windCanvas = windCanvasRef.current;
        const windCtx = windCanvas?.getContext("2d");
        if (windCanvas && windCtx) windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
        controls.dispose();
        disposeObject(meshRef.current);
        disposeObject(overlayRef.current);
        disposeObject(overlayPlanesRef.current);
        disposeObject(classPointsRef.current);
        disposeObject(isoVolumeBodiesRef.current);
        disposeObject(isoSurfaceRef.current);
        disposeObject(guideRef.current);
        meshRef.current?.parent?.remove(meshRef.current);
        overlayRef.current?.parent?.remove(overlayRef.current);
        overlayPlanesRef.current?.parent?.remove(overlayPlanesRef.current);
        classPointsRef.current?.parent?.remove(classPointsRef.current);
        isoVolumeBodiesRef.current?.parent?.remove(isoVolumeBodiesRef.current);
        isoSurfaceRef.current?.parent?.remove(isoSurfaceRef.current);
        guideRef.current?.parent?.remove(guideRef.current);
        meshRef.current = null;
        overlayRef.current = null;
        overlayPlanesRef.current = null;
        classPointsRef.current = null;
        isoVolumeBodiesRef.current = null;
        isoSurfaceRef.current = null;
        guideRef.current = null;
        meshAxesRef.current = null;
        meshDepthRef.current = null;
        domainFitRef.current = null;
        renderer.dispose();
        if (host.contains(renderer.domElement)) host.removeChild(renderer.domElement);
        scene.clear();
        sceneRef.current = null;
        rendererRef.current = null;
        cameraRef.current = null;
        controlsRef.current = null;
        hemiLightRef.current = null;
        keyLightRef.current = null;
        fillLightRef.current = null;
      };
    } catch (error: unknown) {
      console.error("Three.js initialization failed", error);
      setRuntimeStatus("failed");
      setRuntimeError(
        error instanceof Error ? error.message : "Three.js initialization failed."
      );
      return undefined;
    }
  }, [cancelScheduledFits, fitCameraToDomain, pickFromClient]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const hemi = hemiLightRef.current;
    const key = keyLightRef.current;
    const fill = fillLightRef.current;
    if (!renderer || !hemi || !key || !fill) return;
    if (isDayTheme) {
      hemi.color.set(0xfafcff);
      hemi.groundColor.set(0xe2edf7);
      hemi.intensity = 1.05;
      key.color.set(0xffffff);
      key.intensity = 1.15;
      fill.color.set(0xb8dfff);
      fill.intensity = 0.48;
    } else {
      hemi.color.set(0xf1f5f9);
      hemi.groundColor.set(0x1f2937);
      hemi.intensity = 0.85;
      key.color.set(0xffffff);
      key.intensity = 1.0;
      fill.color.set(0x93c5fd);
      fill.intensity = 0.38;
    }
  }, [isDayTheme]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh) mesh.scale.z = verticalScale;
    if (overlayRef.current) overlayRef.current.scale.z = verticalScale;
    if (overlayPlanesRef.current) overlayPlanesRef.current.scale.z = verticalScale;
    if (isoVolumeBodiesRef.current) isoVolumeBodiesRef.current.scale.z = verticalScale;
    if (isoSurfaceRef.current) isoSurfaceRef.current.scale.z = verticalScale;
  }, [verticalScale]);

  useEffect(() => {
    if (!props.cameraResetNonce) return;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    camera.position.set(-180, -250, 190);
    controls.target.set(0, 0, -35);
    controls.update();
    scheduleStabilizedFit(true);
  }, [props.cameraResetNonce, scheduleStabilizedFit]);

  useEffect(() => {
    if (props.cameraAutoFitKey == null) return;
    scheduleStabilizedFit(true);
  }, [props.cameraAutoFitKey, scheduleStabilizedFit]);

  useEffect(() => {
    const scene = sceneRef.current;
    const controls = controlsRef.current;
    if (!scene || !grid) return;

    const maxVertices = props.bathySource === "rtopo" ? TARGET_VERTICES_RTOPO : TARGET_VERTICES_MODEL;
    const sampled = downsampleGrid(grid, maxVertices);
    const nx = sampled.lon.length;
    const ny = sampled.lat.length;
    if (nx < 2 || ny < 2) return;

    const lonMin = Number(sampled.lon[0]);
    const lonMax = Number(sampled.lon[nx - 1]);
    const latMin = Number(sampled.lat[0]);
    const latMax = Number(sampled.lat[ny - 1]);
    const lonSpan = Math.max(1e-9, lonMax - lonMin);
    const latSpan = Math.max(1e-9, latMax - latMin);
    const meanLatRad = ((latMin + latMax) * 0.5 * Math.PI) / 180;
    const xKm = Math.max(1e-9, lonSpan * Math.cos(meanLatRad) * 111.32);
    const yKm = Math.max(1e-9, latSpan * 111.32);
    const width = BASE_MESH_WIDTH;
    const height = BASE_MESH_WIDTH * (yKm / xKm);

    const geometry = new THREE.PlaneGeometry(width, height, nx - 1, ny - 1);
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(nx * ny * 3);

    let zMin = Number.POSITIVE_INFINITY;
    let zMax = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const z = Number(sampled.z[j]?.[i]);
        if (!Number.isFinite(z)) continue;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }
    }
    if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || zMax <= zMin) {
      zMin = -5000;
      zMax = 2500;
    }
    setBathyRange({ min: zMin, max: zMax });
    const showBathy = props.showBathy ?? true;
    const lonToX = (lon: number) => ((lon - lonMin) / Math.max(1e-9, lonSpan) - 0.5) * width;
    const latToY = (lat: number) => ((lat - latMin) / Math.max(1e-9, latSpan) - 0.5) * height;

    for (let row = 0; row < ny; row += 1) {
      const geomRow = ny - 1 - row;
      const latVal = Number(sampled.lat[row]);
      const y = latToY(latVal);
      for (let col = 0; col < nx; col += 1) {
        const idx = geomRow * nx + col;
        const lonVal = Number(sampled.lon[col]);
        const x = lonToX(lonVal);
        position.setX(idx, Number.isFinite(x) ? x : 0);
        position.setY(idx, Number.isFinite(y) ? y : 0);
        const zRaw = Number(sampled.z[row]?.[col]);
        position.setZ(idx, Number.isFinite(zRaw) ? zRaw : 0);

        const bathyT = clamp((zRaw - zMin) / Math.max(1e-9, zMax - zMin), 0, 1);
        const baseColor = colorFromPalette(bathyPalette, bathyT);
        colors[idx * 3] = baseColor.r;
        colors[idx * 3 + 1] = baseColor.g;
        colors[idx * 3 + 2] = baseColor.b;
      }
    }

    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: showBathy ? clamp(Number(props.bathyOpacity ?? 1), 0, 1) : 0,
      roughness: 0.94,
      metalness: 0.05,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.z = verticalScale;
    meshRef.current?.parent?.remove(meshRef.current);
    disposeObject(meshRef.current);
    meshRef.current = mesh;
    scene.add(mesh);

    meshFrameRef.current = {
      width,
      height,
      lonMin,
      lonMax,
      latMin,
      latMax,
    };
    meshAxesRef.current = {
      lon: sampled.lon.slice(),
      lat: sampled.lat.slice(),
    };
    meshDepthRef.current = (sampled.zRaw ?? sampled.z).map((row) => row.map((v) => Number(v)));
    const centerZ = ((zMin + zMax) * 0.5) * verticalScale;
    const halfDepth = ((zMax - zMin) * 0.5) * verticalScale;
    const domainRadius = Math.max(1, Math.hypot(width * 0.5, height * 0.5, halfDepth));
    domainFitRef.current = {
      center: new THREE.Vector3(0, 0, centerZ),
      radius: domainRadius,
    };
    setMeshFrameNonce((v) => v + 1);

    if (controls) scheduleStabilizedFit(!didSetInitialTargetRef.current);

    setRuntimeStatus("ready");
    setRuntimeError(null);
  }, [
    bathyPalette,
    grid,
    props.bathyOpacity,
    props.bathySource,
    props.showBathy,
    fitCameraToDomain,
    verticalScale,
    scheduleStabilizedFit,
  ]);

  useEffect(() => {
    const scene = sceneRef.current;
    const frame = meshFrameRef.current;
    const meshAxes = meshAxesRef.current;
    const meshDepth = meshDepthRef.current;

    overlayRef.current?.parent?.remove(overlayRef.current);
    disposeObject(overlayRef.current);
    overlayRef.current = null;
    overlayPlanesRef.current?.parent?.remove(overlayPlanesRef.current);
    disposeObject(overlayPlanesRef.current);
    overlayPlanesRef.current = null;
    classPointsRef.current?.parent?.remove(classPointsRef.current);
    disposeObject(classPointsRef.current);
    classPointsRef.current = null;
    isoVolumeBodiesRef.current?.parent?.remove(isoVolumeBodiesRef.current);
    disposeObject(isoVolumeBodiesRef.current);
    isoVolumeBodiesRef.current = null;
    isoSurfaceRef.current?.parent?.remove(isoSurfaceRef.current);
    disposeObject(isoSurfaceRef.current);
    isoSurfaceRef.current = null;

    if (!scene || !frame || !meshAxes || !meshDepth) return;
    const field = props.horizontalField;
    if (field?.enabled) {
      const overlay = buildScalarPlaneMesh({
        field,
        frame,
        meshLon: meshAxes.lon,
        meshLat: meshAxes.lat,
        meshDepth,
        verticalScale,
      });
      if (overlay) {
        scene.add(overlay);
        overlayRef.current = overlay;
      }
    }

    const planes = (props.horizontalPlanes ?? []).filter((p) => p?.enabled);
    if (planes.length) {
      const group = new THREE.Group();
      group.scale.z = verticalScale;
      group.renderOrder = 6;
      planes.forEach((plane) => {
        const mesh = buildScalarPlaneMesh({
          field: plane,
          frame,
          meshLon: meshAxes.lon,
          meshLat: meshAxes.lat,
          meshDepth,
          verticalScale: 1,
          maxVertices: TARGET_FIELD_VERTICES,
        });
        if (mesh) group.add(mesh);
      });
      if (group.children.length) {
        scene.add(group);
        overlayPlanesRef.current = group;
      } else {
        disposeObject(group);
      }
    }
    const classLayer = props.classLayer;
    if (classLayer?.enabled) {
      const classObject =
        classLayer.renderStyle === "voxels"
          ? buildClassVoxelObject({
              layer: classLayer,
              frame,
              verticalScale,
            })
          : buildClassPointsObject({
              layer: classLayer,
              frame,
              verticalScale,
            });
      if (classObject) {
        scene.add(classObject);
        classPointsRef.current = classObject;
      }
    }
    const isoVolumeBodiesLayer = props.isoVolumeBodiesLayer;
    if (isoVolumeBodiesLayer?.enabled) {
      const volumeBodies = buildIsoVolumeBodiesObject({
        layer: isoVolumeBodiesLayer,
        frame,
        verticalScale,
        bathyLon: meshAxes.lon,
        bathyLat: meshAxes.lat,
        bathyDepth: meshDepth,
      });
      if (volumeBodies) {
        scene.add(volumeBodies);
        isoVolumeBodiesRef.current = volumeBodies;
      }
    }
    const isoSurface = props.isoSurfaceLayer;
    if (isoSurface?.enabled) {
      const mesh = buildIsoDepthMesh({
        layer: isoSurface,
        frame,
        verticalScale,
      });
      if (mesh) {
        scene.add(mesh);
        isoSurfaceRef.current = mesh;
      }
    }
  }, [
    meshFrameNonce,
    props.classLayer,
    props.horizontalField,
    props.horizontalPlanes,
    props.isoSurfaceLayer,
    props.isoVolumeBodiesLayer,
    verticalScale,
  ]);

  const colorbars = useMemo<ColorbarViewModel[]>(() => {
    const out: ColorbarViewModel[] = [];
    const field = props.horizontalField;
    if (
      field?.enabled &&
      field.showScale &&
      Number.isFinite(field.cmin) &&
      Number.isFinite(field.cmax) &&
      field.cmax > field.cmin &&
      Array.isArray(field.colorscale) &&
      field.colorscale.length
    ) {
      const ticks = field.colorbarTicks?.length
        ? field.colorbarTicks.filter((v) => Number.isFinite(v))
        : makeAutoTicks(field.cmin, field.cmax, 6);
      out.push({
        id: "field",
        title: field.colorbarTitle ?? "Value",
        gradient: colorscaleToCssGradient(field.colorscale),
        min: field.cmin,
        max: field.cmax,
        ticks,
        tickText: field.colorbarTickText?.length
          ? field.colorbarTickText
          : formatColorbarTickText(ticks, field.colorbarTitle ?? "Value"),
        len: clamp(Number(field.colorbarLen ?? 0.62), 0.25, 0.95),
      });
    }

    for (const plane of props.horizontalPlanes ?? []) {
      if (
        !plane?.enabled ||
        !plane.showScale ||
        !Number.isFinite(plane.cmin) ||
        !Number.isFinite(plane.cmax) ||
        plane.cmax <= plane.cmin ||
        !Array.isArray(plane.colorscale) ||
        !plane.colorscale.length
      ) {
        continue;
      }
      const ticks = plane.colorbarTicks?.length
        ? plane.colorbarTicks.filter((v) => Number.isFinite(v))
        : makeAutoTicks(plane.cmin, plane.cmax, 6);
      out.push({
        id: `plane-${out.length}`,
        title: plane.colorbarTitle ?? "Value",
        gradient: colorscaleToCssGradient(plane.colorscale),
        min: plane.cmin,
        max: plane.cmax,
        ticks,
        tickText: plane.colorbarTickText?.length
          ? plane.colorbarTickText
          : formatColorbarTickText(ticks, plane.colorbarTitle ?? "Value"),
        len: clamp(Number(plane.colorbarLen ?? 0.62), 0.25, 0.95),
      });
    }

    const classLayer = props.classLayer;
    if (
      classLayer?.enabled &&
      classLayer.showScale &&
      Number.isFinite(classLayer.cmin) &&
      Number.isFinite(classLayer.cmax) &&
      classLayer.cmax > classLayer.cmin &&
      Array.isArray(classLayer.colorscale) &&
      classLayer.colorscale.length
    ) {
      const ticks = classLayer.colorbarTicks?.length
        ? classLayer.colorbarTicks.filter((v) => Number.isFinite(v))
        : makeAutoTicks(classLayer.cmin, classLayer.cmax, 6);
      out.push({
        id: "class",
        title: classLayer.colorbarTitle ?? classLayer.varLabel ?? "Class",
        gradient: colorscaleToCssGradient(classLayer.colorscale),
        min: classLayer.cmin,
        max: classLayer.cmax,
        ticks,
        tickText: classLayer.colorbarTickText?.length
          ? classLayer.colorbarTickText
          : formatColorbarTickText(ticks, classLayer.colorbarTitle ?? classLayer.varLabel ?? "Class"),
        len: clamp(Number(classLayer.colorbarLen ?? 0.62), 0.25, 0.95),
      });
    }

    const isoSurface = props.isoSurfaceLayer;
    if (
      isoSurface?.enabled &&
      isoSurface.showScale &&
      Number.isFinite(isoSurface.cmin) &&
      Number.isFinite(isoSurface.cmax) &&
      isoSurface.cmax > isoSurface.cmin &&
      Array.isArray(isoSurface.colorscale) &&
      isoSurface.colorscale.length
    ) {
      const ticks = isoSurface.colorbarTicks?.length
        ? isoSurface.colorbarTicks.filter((v) => Number.isFinite(v))
        : makeAutoTicks(isoSurface.cmin, isoSurface.cmax, 6);
      out.push({
        id: "iso-surface",
        title: isoSurface.colorbarTitle ?? "Value",
        gradient: colorscaleToCssGradient(isoSurface.colorscale),
        min: isoSurface.cmin,
        max: isoSurface.cmax,
        ticks,
        tickText: isoSurface.colorbarTickText?.length
          ? isoSurface.colorbarTickText
          : formatColorbarTickText(ticks, isoSurface.colorbarTitle ?? "Value"),
        len: clamp(Number(isoSurface.colorbarLen ?? 0.62), 0.25, 0.95),
      });
    }

    const cc = props.currentsColorbar;
    if (cc && Array.isArray(cc.colorscale) && cc.colorscale.length && cc.cmax > cc.cmin) {
      out.push({
        id: "currents",
        title: cc.title,
        gradient: colorscaleToCssGradient(cc.colorscale),
        min: cc.cmin,
        max: cc.cmax,
        ticks: cc.ticks,
        tickText: cc.tickText,
        len: clamp(Number(cc.len ?? 0.5), 0.25, 0.95),
      });
    }

    if (
      props.bathyColorbar?.enabled &&
      (props.showBathy ?? true) &&
      bathyRange &&
      Number.isFinite(bathyRange.min) &&
      Number.isFinite(bathyRange.max) &&
      bathyRange.max > bathyRange.min
    ) {
      const ticks = props.bathyColorbar.tickvals?.length
        ? props.bathyColorbar.tickvals.filter((v) => Number.isFinite(v))
        : makeBathymetryTicks(bathyRange.min, bathyRange.max);
      out.push({
        id: "bathy",
        title: props.bathyColorbar.title ?? "Bed elevation (m)",
        gradient: paletteToCssGradient(bathyPalette),
        min: bathyRange.min,
        max: bathyRange.max,
        ticks,
        len: clamp(Number(props.bathyColorbar.len ?? 0.62), 0.25, 0.95),
      });
    }

    return out;
  }, [
    bathyPalette,
    bathyRange,
    props.bathyColorbar,
    props.classLayer,
    props.horizontalField,
    props.horizontalPlanes,
    props.isoSurfaceLayer,
    props.showBathy,
    props.currentsColorbar,
  ]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    guideRef.current?.parent?.remove(guideRef.current);
    disposeObject(guideRef.current);
    guideRef.current = null;

    const guide = props.guidePath;
    const frame = meshFrameRef.current;
    if (!guide?.enabled || !frame) return;
    if (!guide.lon.length || !guide.lat.length || guide.lon.length !== guide.lat.length) return;

    const n = guide.lon.length;
    const positions = new Float32Array(n * 3);
    const zPlane = Number.isFinite(guide.zPlane) ? Number(guide.zPlane) : 40;

    for (let i = 0; i < n; i += 1) {
      const lon = Number(guide.lon[i]);
      const lat = Number(guide.lat[i]);
      const u = clamp((lon - frame.lonMin) / Math.max(1e-9, frame.lonMax - frame.lonMin), 0, 1);
      const v = clamp((lat - frame.latMin) / Math.max(1e-9, frame.latMax - frame.latMin), 0, 1);
      positions[i * 3] = (u - 0.5) * frame.width;
      positions[i * 3 + 1] = (v - 0.5) * frame.height;
      positions[i * 3 + 2] = zPlane;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: parseCssColor(guide.color ?? "#f8fafc"),
      transparent: true,
      opacity: clamp(Number(guide.opacity ?? 0.95), 0, 1),
      linewidth: Math.max(1, Math.round(Number(guide.width ?? 3))),
    });
    const line = new THREE.Line(geometry, material);
    guideRef.current = line;
    mesh.add(line);
  }, [props.guidePath]);

  useEffect(() => {
    if (windRafRef.current != null) {
      window.cancelAnimationFrame(windRafRef.current);
      windRafRef.current = null;
    }
    windParticlesRef.current = [];
    const canvas = windCanvasRef.current;
    const clearCanvas = () => {
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    clearCanvas();

    const inputLayers = [props.windLayer, ...(props.currentLayers ?? [])].filter(
      (l): l is WindLayer => !!(l && l.enabled)
    );
    const frame = meshFrameRef.current;
    const meshAxes = meshAxesRef.current;
    const meshDepth = meshDepthRef.current;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!inputLayers.length || !frame || !meshAxes || !meshDepth || !renderer || !camera || !controls || !canvas)
      return;

    const meshLon = meshAxes.lon;
    const meshLat = meshAxes.lat;
    const mx = meshLon.length;
    const my = meshLat.length;
    if (mx < 2 || my < 2) return;
    const meshLonAsc = meshLon[mx - 1] >= meshLon[0];
    const meshLatAsc = meshLat[my - 1] >= meshLat[0];
    const meshLonMin = Math.min(meshLon[0], meshLon[mx - 1]);
    const meshLonMax = Math.max(meshLon[0], meshLon[mx - 1]);
    const meshLatMin = Math.min(meshLat[0], meshLat[my - 1]);
    const meshLatMax = Math.max(meshLat[0], meshLat[my - 1]);
    const meshLonSpan = Math.max(1e-9, meshLonMax - meshLonMin);
    const meshLatSpan = Math.max(1e-9, meshLatMax - meshLatMin);
    const oceanThreshold = -5;

    // Shared land/edge test from the bathymetry mesh: particles only live over
    // wet cells and respawn at NaN / coastlines / domain edges.
    const isOcean = (x: number, y: number) => {
      if (x < meshLonMin || x > meshLonMax || y < meshLatMin || y > meshLatMax) return false;
      const tx = (x - meshLonMin) / meshLonSpan;
      const ty = (y - meshLatMin) / meshLatSpan;
      const cx = tx * (mx - 1);
      const cy = ty * (my - 1);
      const ux = meshLonAsc ? cx : mx - 1 - cx;
      const uy = meshLatAsc ? cy : my - 1 - cy;
      const i0 = Math.max(0, Math.min(mx - 1, Math.floor(ux)));
      const j0 = Math.max(0, Math.min(my - 1, Math.floor(uy)));
      const i1 = Math.min(mx - 1, i0 + 1);
      const j1 = Math.min(my - 1, j0 + 1);
      const d00 = Number(meshDepth[j0]?.[i0]);
      const d10 = Number(meshDepth[j0]?.[i1]);
      const d01 = Number(meshDepth[j1]?.[i0]);
      const d11 = Number(meshDepth[j1]?.[i1]);
      if (!Number.isFinite(d00) || !Number.isFinite(d10) || !Number.isFinite(d01) || !Number.isFinite(d11)) {
        return false;
      }
      const wetCorners = Number(d00 < oceanThreshold) + Number(d10 < oceanThreshold) + Number(d01 < oceanThreshold) + Number(d11 < oceanThreshold);
      return wetCorners >= 2;
    };

    const project = (lonVal: number, latVal: number, zWorld: number) => {
      const wx = ((lonVal - frame.lonMin) / Math.max(1e-9, frame.lonMax - frame.lonMin) - 0.5) * frame.width;
      const wy = ((latVal - frame.latMin) / Math.max(1e-9, frame.latMax - frame.latMin) - 0.5) * frame.height;
      const vec = new THREE.Vector3(wx, wy, zWorld);
      vec.project(camera);
      if (!Number.isFinite(vec.x) || !Number.isFinite(vec.y) || !Number.isFinite(vec.z)) return null;
      if (vec.z < -1.2 || vec.z > 1.2 || Math.abs(vec.x) > 1.2 || Math.abs(vec.y) > 1.2) return null;
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      return { x: (vec.x * 0.5 + 0.5) * w, y: (-vec.y * 0.5 + 0.5) * h };
    };

    type LayerState = {
      sampler: (x: number, y: number) => { uu: number; vv: number } | null;
      spawn: () => WindParticle;
      advectScale: number;
      zWorld: number;
      strokeColor: string;
      lineWidth: number;
      trailLen: number;
      particles: WindParticle[];
      lonMin: number;
      lonMax: number;
      latMin: number;
      latMax: number;
      baseParticleCount: number;
      zoomAdaptive: boolean;
    };

    const buildLayerState = (layer: WindLayer): LayerState | null => {
      const lon = layer.lon ?? [];
      const lat = layer.lat ?? [];
      const u = layer.u ?? [];
      const v = layer.v ?? [];
      const nx = lon.length;
      const ny = lat.length;
      if (!nx || !ny) return null;
      if (u.length !== ny || v.length !== ny) return null;
      if ((u[0]?.length ?? 0) !== nx || (v[0]?.length ?? 0) !== nx) return null;

      const lon0 = Number(lon[0]);
      const lonN = Number(lon[nx - 1]);
      const lat0 = Number(lat[0]);
      const latN = Number(lat[ny - 1]);
      const lonAsc = lonN >= lon0;
      const latAsc = latN >= lat0;
      const lonMin = Math.min(lon0, lonN);
      const lonMax = Math.max(lon0, lonN);
      const latMin = Math.min(lat0, latN);
      const latMax = Math.max(lat0, latN);
      const lonSpan = Math.max(1e-9, lonMax - lonMin);
      const latSpan = Math.max(1e-9, latMax - latMin);

      const sampler = (x: number, y: number) => {
        if (x < lonMin || x > lonMax || y < latMin || y > latMax) return null;
        if (!isOcean(x, y)) return null;
        const tx = (x - lonMin) / lonSpan;
        const ty = (y - latMin) / latSpan;
        const cx = tx * (nx - 1);
        const cy = ty * (ny - 1);
        const ux = lonAsc ? cx : nx - 1 - cx;
        const uy = latAsc ? cy : ny - 1 - cy;
        const i0 = Math.max(0, Math.min(nx - 1, Math.floor(ux)));
        const j0 = Math.max(0, Math.min(ny - 1, Math.floor(uy)));
        const i1 = Math.min(nx - 1, i0 + 1);
        const j1 = Math.min(ny - 1, j0 + 1);
        const fx = Math.max(0, Math.min(1, ux - i0));
        const fy = Math.max(0, Math.min(1, uy - j0));
        const u00 = Number(u[j0]?.[i0]);
        const u10 = Number(u[j0]?.[i1]);
        const u01 = Number(u[j1]?.[i0]);
        const u11 = Number(u[j1]?.[i1]);
        const v00 = Number(v[j0]?.[i0]);
        const v10 = Number(v[j0]?.[i1]);
        const v01 = Number(v[j1]?.[i0]);
        const v11 = Number(v[j1]?.[i1]);
        if (
          !Number.isFinite(u00) || !Number.isFinite(u10) || !Number.isFinite(u01) || !Number.isFinite(u11) ||
          !Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)
        ) {
          return null;
        }
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const uu = u00 * w00 + u10 * w10 + u01 * w01 + u11 * w11;
        const vv = v00 * w00 + v10 * w10 + v01 * w01 + v11 * w11;
        if (!Number.isFinite(uu) || !Number.isFinite(vv)) return null;
        return { uu, vv };
      };

      let maxMag = 0;
      for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
          const uu = Number(u[j]?.[i]);
          const vv = Number(v[j]?.[i]);
          if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue;
          maxMag = Math.max(maxMag, Math.hypot(uu, vv));
        }
      }
      const targetDegPerSec = 1.8 * Math.max(0.1, Number(layer.speed ?? 1));
      const advectScale = maxMag > 1e-8 ? Math.min(120, targetDegPerSec / maxMag) : 0;
      const nParticles = Math.max(40, Math.min(2800, Math.round(Number(layer.particleCount ?? 1000))));
      const trailLen = Math.max(10, Math.min(44, Math.round((layer.size ?? 1.4) * 13)));
      const strokeColor = layer.color ?? "rgba(255,255,255,0.9)";
      const lineWidth = Math.max(0.8, Number(layer.size ?? 1.2));
      const zWorld = Number(layer.zPlane ?? 8) * verticalScale;

      const spawn = (): WindParticle => {
        for (let n = 0; n < 90; n += 1) {
          const x = lonMin + Math.random() * lonSpan;
          const y = latMin + Math.random() * latSpan;
          const w = sampler(x, y);
          if (!w) continue;
          const speed = Math.hypot(w.uu, w.vv);
          if (speed <= 1e-8) continue;
          return { x, y, ttl: 2 + Math.random() * 5, speed, trail: [{ x, y, speed }] };
        }
        const x = (lonMin + lonMax) * 0.5;
        const y = (latMin + latMax) * 0.5;
        return { x, y, ttl: 1.5, speed: 0, trail: [{ x, y, speed: 0 }] };
      };

      const particles = Array.from({ length: nParticles }, () => spawn());
      return {
        sampler,
        spawn,
        advectScale,
        zWorld,
        strokeColor,
        lineWidth,
        trailLen,
        particles,
        lonMin,
        lonMax,
        latMin,
        latMax,
        baseParticleCount: nParticles,
        zoomAdaptive: Boolean(layer.zoomAdaptive),
      };
    };

    const states = inputLayers
      .map(buildLayerState)
      .filter((s): s is LayerState => s != null);
    if (!states.length) return;
    windParticlesRef.current = states.flatMap((s) => s.particles);

    const fit = domainFitRef.current;
    const fitFov = THREE.MathUtils.degToRad(camera.fov);
    const fitHFov = 2 * Math.atan(Math.tan(fitFov * 0.5) * Math.max(1e-4, camera.aspect || 1));
    const referenceDistance = fit
      ? Math.max(
          fit.radius / Math.max(1e-4, Math.sin(fitFov * 0.5)),
          fit.radius / Math.max(1e-4, Math.sin(fitHFov * 0.5))
        ) * 0.8
      : camera.position.distanceTo(controls.target);
    let lastZoomDensitySync = 0;

    const syncZoomAdaptiveParticles = (ts: number) => {
      if (ts - lastZoomDensitySync < 250) return;
      lastZoomDensitySync = ts;
      const adaptiveStates = states.filter((state) => state.zoomAdaptive);
      if (!adaptiveStates.length) return;
      const currentDistance = camera.position.distanceTo(controls.target);
      const zoomDensity =
        Number.isFinite(referenceDistance) && Number.isFinite(currentDistance) && currentDistance > 1e-6
          ? clamp(referenceDistance / currentDistance, 1, 2.5)
          : 1;
      const baseTotal = adaptiveStates.reduce((sum, state) => sum + state.baseParticleCount, 0);
      const desiredTotal = Math.min(4800, Math.round(baseTotal * zoomDensity * zoomDensity));

      for (const state of adaptiveStates) {
        const target = Math.max(
          24,
          Math.min(2800, Math.round(desiredTotal * (state.baseParticleCount / Math.max(1, baseTotal))))
        );
        if (state.particles.length > target) {
          state.particles.length = target;
        } else {
          while (state.particles.length < target) state.particles.push(state.spawn());
        }
      }
      windParticlesRef.current = states.flatMap((state) => state.particles);
    };

    let lastTs = 0;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const cssW = Math.max(1, Math.round(canvas.clientWidth || renderer.domElement.clientWidth || 1));
      const cssH = Math.max(1, Math.round(canvas.clientHeight || renderer.domElement.clientHeight || 1));
      const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
      const targetW = Math.max(1, Math.round(cssW * dpr));
      const targetH = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // Draw deepest layers first so shallow flow reads on top.
      for (const st of states) {
        ctx.strokeStyle = st.strokeColor;
        ctx.lineWidth = st.lineWidth;
        for (const p of st.particles) {
          let prev: { x: number; y: number } | null = null;
          for (let i = 0; i < p.trail.length; i += 1) {
            const tp = p.trail[i];
            const sp = project(tp.x, tp.y, st.zWorld);
            if (!sp) {
              prev = null;
              continue;
            }
            if (prev) {
              const age = p.trail.length > 1 ? i / (p.trail.length - 1) : 1;
              ctx.globalAlpha = 0.15 + 0.7 * age * age;
              ctx.beginPath();
              ctx.moveTo(prev.x, prev.y);
              ctx.lineTo(sp.x, sp.y);
              ctx.stroke();
            }
            prev = sp;
          }
        }
      }
      ctx.globalAlpha = 1;
    };

    const tick = (ts: number) => {
      const dtRaw = lastTs ? (ts - lastTs) / 1000 : 1 / 60;
      lastTs = ts;
      const dt = Math.max(0.001, Math.min(0.04, dtRaw));
      syncZoomAdaptiveParticles(ts);
      for (const st of states) {
        const particles = st.particles;
        for (let i = 0; i < particles.length; i += 1) {
          const p = particles[i];
          if (p.ttl <= 0) {
            particles[i] = st.spawn();
            continue;
          }
          const w0 = st.sampler(p.x, p.y);
          if (!w0) {
            particles[i] = st.spawn();
            continue;
          }
          const k = st.advectScale * dt;
          const cosLat0 = Math.max(0.15, Math.abs(Math.cos((p.y * Math.PI) / 180)));
          const midX = p.x + (w0.uu / cosLat0) * k * 0.5;
          const midY = p.y + w0.vv * k * 0.5;
          const wm = st.sampler(midX, midY) ?? w0;
          p.speed = Math.hypot(wm.uu, wm.vv);
          const cosLatMid = Math.max(0.15, Math.abs(Math.cos((midY * Math.PI) / 180)));
          p.x += (wm.uu / cosLatMid) * k;
          p.y += wm.vv * k;
          p.ttl -= dt;
          if (!isOcean(p.x, p.y) || p.x < st.lonMin || p.x > st.lonMax || p.y < st.latMin || p.y > st.latMax) {
            particles[i] = st.spawn();
            continue;
          }
          p.trail.push({ x: p.x, y: p.y, speed: p.speed });
          if (p.trail.length > st.trailLen) p.trail.splice(0, p.trail.length - st.trailLen);
        }
      }
      draw();
      windRafRef.current = window.requestAnimationFrame(tick);
    };
    draw();
    windRafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (windRafRef.current != null) {
        window.cancelAnimationFrame(windRafRef.current);
        windRafRef.current = null;
      }
      windParticlesRef.current = [];
      clearCanvas();
    };
  }, [meshFrameNonce, props.windLayer, props.currentLayers, verticalScale]);

  const bathyColorbar = colorbars.find((bar) => bar.id === "bathy") ?? null;
  const scalarColorbars = colorbars.filter((bar) => bar.id !== "bathy");

  return (
      <div
        className="basemap"
        ref={containerRef}
        style={{
          cursor: props.drawingMode ? "crosshair" : "grab",
          background: isDayTheme
            ? "radial-gradient(1100px 760px at 58% 26%, rgba(234,243,251,0.96) 0%, rgba(201,221,239,0.94) 56%, rgba(173,197,221,0.92) 100%)"
            : "radial-gradient(1100px 760px at 58% 26%, rgba(12,28,51,0.92) 0%, rgba(7,10,18,0.94) 58%, rgba(5,6,11,0.98) 100%)",
        }}
      >
      {runtimeStatus === "loading" || bathyStatus === "loading" ? (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(0,0,0,0.28)",
            color: "rgba(255,255,255,0.78)",
            fontSize: 12,
            zIndex: 3,
          }}
        >
          Loading Three.js terrain…
        </div>
      ) : null}
      {runtimeStatus === "failed" ? (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(0,0,0,0.35)",
            color: "rgba(255,255,255,0.85)",
            fontSize: 12,
            maxWidth: 520,
            zIndex: 3,
          }}
        >
          Three.js renderer failed to initialize.
          {runtimeError ? <div style={{ marginTop: 6 }}>{runtimeError}</div> : null}
        </div>
      ) : null}
      {scalarColorbars.map((bar, barIndex) => (
        <div
          key={bar.id}
          style={{
            position: "absolute",
            right: 44,
            bottom: 18 + (bathyColorbar ? 78 : 0) + 76 * barIndex,
            width: 260,
            zIndex: 3,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#ffffff",
              textShadow: "0 1px 2px rgba(0,0,0,0.75)",
              marginBottom: 6,
              textAlign: "right",
              whiteSpace: "nowrap",
            }}
          >
            {bar.title}
          </div>
          <div
            style={{
              height: 14,
              borderRadius: 9,
              border: "1px solid rgba(255,255,255,0.36)",
              background: bar.gradient.replace("to top", "to right"),
              boxShadow: "0 0 0 1px rgba(0,0,0,0.28) inset",
              position: "relative",
            }}
          />
          <div style={{ position: "relative", height: 18, marginTop: 4 }}>
            {bar.ticks.map((tick, tickIndex) => {
              const t = clamp((tick - bar.min) / Math.max(1e-9, bar.max - bar.min), 0, 1);
              return (
                <div
                  key={`${bar.id}-tick-${tick}`}
                  style={{
                    position: "absolute",
                    left: `calc(${(t * 100).toFixed(2)}% - 16px)`,
                    top: 0,
                    width: 32,
                  textAlign: "center",
                  fontSize: 10,
                  lineHeight: 1.1,
                  color: "#ffffff",
                  textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                  whiteSpace: "nowrap",
                }}
                >
                  {bar.tickText?.[tickIndex] ?? formatColorbarTick(tick, bar.title)}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {bathyColorbar ? (
        <div
          style={{
            position: "absolute",
            right: 44,
            bottom: 18,
            width: 260,
            zIndex: 3,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#ffffff",
              textShadow: "0 1px 2px rgba(0,0,0,0.75)",
              marginBottom: 6,
              textAlign: "right",
              whiteSpace: "nowrap",
            }}
          >
            {bathyColorbar.title}
          </div>
          {props.bathyColorbar?.subtitle ? (
            <div
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "rgba(255,255,255,0.70)",
                textShadow: "0 1px 2px rgba(0,0,0,0.75)",
                marginBottom: 6,
                textAlign: "right",
                whiteSpace: "nowrap",
              }}
            >
              {props.bathyColorbar.subtitle}
            </div>
          ) : null}
          <div
            style={{
              height: 14,
              borderRadius: 9,
              border: "1px solid rgba(255,255,255,0.36)",
              background: bathyColorbar.gradient.replace("to top", "to right"),
              boxShadow: "0 0 0 1px rgba(0,0,0,0.28) inset",
              position: "relative",
            }}
          />
          <div style={{ position: "relative", height: 18, marginTop: 4 }}>
            {bathyColorbar.ticks.map((tick, tickIndex) => {
              const t = clamp((tick - bathyColorbar.min) / Math.max(1e-9, bathyColorbar.max - bathyColorbar.min), 0, 1);
              return (
                <div
                  key={`bathy-h-${tick}`}
                  style={{
                    position: "absolute",
                    left: `calc(${(t * 100).toFixed(2)}% - 16px)`,
                    top: 0,
                    width: 32,
                    textAlign: "center",
                    fontSize: 10,
                    lineHeight: 1.1,
                    color: "#ffffff",
                    textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatColorbarTick(tick, bathyColorbar.title)}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {props.viewerHint ? <div className="mapFooterHint">{props.viewerHint}</div> : null}
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
