import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const manifestPath = path.join(repoRoot, "public/data/RTopo_30arcsec.json");
const outputPath = path.join(repoRoot, "public/maps/horizontal/nordic-bathymetry-transparent.svg");
const renderPagePath = path.join(repoRoot, "public/maps/horizontal/nordic-bathymetry-transparent.render.html");

const stride = Math.max(4, Number.parseInt(process.argv[2] ?? "10", 10) || 10);
const depthRatio = Math.max(0.1, Number.parseFloat(process.argv[3] ?? "0.55") || 0.55);
const canvasAspect = Number.parseFloat(process.argv[4] ?? `${1308 / 1200}`) || 1308 / 1200;
const smoothPasses = Math.max(0, Number.parseInt(process.argv[5] ?? "3", 10) || 3);

const BASE_MESH_WIDTH = 360;
const BASE_Z_SCALE = 0.035;
const DEFAULT_CAMERA_DIRECTION = new THREE.Vector3(0.0, -0.48, 1.08).normalize();
const OCEAN_RELIEF_FACTOR = 0.48;
const LAND_RELIEF_FACTOR = 0.2;
const KEY_LIGHT_POS = new THREE.Vector3(-220, -260, 380);
const FILL_LIGHT_POS = new THREE.Vector3(280, 180, 120);
const OCEAN_STOPS = ["#081a34", "#12396e", "#1f63a6", "#33a0d3", "#83d9e2", "#dff7fb"];
const LAND_STOPS = ["#f3e9c9", "#dbe7c1", "#bfd5a0", "#9cb97b", "#a99f63", "#d8ceb0"];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b]
    .map((value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixRgb(a, b, t) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function makeLinearPalette(hexStops, count) {
  const stops = hexStops.map(hexToRgb);
  const segments = Math.max(1, stops.length - 1);
  return Array.from({ length: count }, (_, index) => {
    const t = index / Math.max(1, count - 1);
    const scaled = t * segments;
    const low = Math.min(segments - 1, Math.floor(scaled));
    const local = scaled - low;
    return mixRgb(stops[low], stops[low + 1], local);
  });
}

function formatTick(value) {
  return `${Math.round(value)}`;
}

function quantizeColor(rgb) {
  const step = 8;
  return {
    r: Math.round(clamp(rgb.r, 0, 255) / step) * step,
    g: Math.round(clamp(rgb.g, 0, 255) / step) * step,
    b: Math.round(clamp(rgb.b, 0, 255) / step) * step,
  };
}

function samplePalette(palette, t) {
  const safe = clamp(t, 0, 1);
  const index = Math.round(safe * (palette.length - 1));
  return palette[Math.max(0, Math.min(palette.length - 1, index))];
}

function applyShade(baseRgb, brightness) {
  const lit = {
    r: baseRgb.r * brightness,
    g: baseRgb.g * brightness,
    b: baseRgb.b * brightness,
  };
  return quantizeColor(lit);
}

function buildSampleIndices(length, step) {
  const indices = [];
  for (let index = 0; index < length; index += step) indices.push(index);
  if (!indices.length || indices[indices.length - 1] !== length - 1) indices.push(length - 1);
  return indices;
}

function smoothGrid(values, passes) {
  let current = values.map((row) => row.slice());
  for (let pass = 0; pass < passes; pass += 1) {
    const next = current.map((row) => row.slice());
    for (let row = 0; row < current.length; row += 1) {
      for (let column = 0; column < current[row].length; column += 1) {
        let sum = 0;
        let weightSum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const rr = row + dy;
            const cc = column + dx;
            if (rr < 0 || rr >= current.length || cc < 0 || cc >= current[row].length) continue;
            const value = Number(current[rr][cc]);
            if (!Number.isFinite(value)) continue;
            const weight = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
            sum += value * weight;
            weightSum += weight;
          }
        }
        if (weightSum > 0) next[row][column] = sum / weightSum;
      }
    }
    current = next;
  }
  return current;
}

function faceNormal(a, b, c) {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const normal = ab.cross(ac);
  if (normal.lengthSq() < 1e-10) return null;
  normal.normalize();
  return normal.z < 0 ? normal.negate() : normal;
}

function lambertBrightness(normal, center, cameraPosition) {
  const keyDir = KEY_LIGHT_POS.clone().sub(center).normalize();
  const fillDir = FILL_LIGHT_POS.clone().sub(center).normalize();
  const viewDir = cameraPosition.clone().sub(center).normalize();
  const hemi = 0.54 + 0.18 * clamp(normal.z, -1, 1);
  const key = 0.48 * Math.max(0, normal.dot(keyDir));
  const fill = 0.22 * Math.max(0, normal.dot(fillDir));
  const rim = 0.08 * (1 - Math.max(0, normal.dot(viewDir)));
  return clamp(hemi + key + fill + rim, 0.58, 1.34);
}

function pathForPoints(points, offsetX, offsetY) {
  let output = `M${(points[0].x - offsetX).toFixed(1)} ${(points[0].y - offsetY).toFixed(1)}`;
  for (let index = 1; index < points.length; index += 1) {
    output += `L${(points[index].x - offsetX).toFixed(1)} ${(points[index].y - offsetY).toFixed(1)}`;
  }
  output += "Z";
  return output;
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const lon = manifest.lon.map(Number);
const lat = manifest.lat.map(Number);
const chunkFiles = Array.isArray(manifest.chunks) ? manifest.chunks : [];

if (!lon.length || !lat.length || !chunkFiles.length) {
  throw new Error("RTopo manifest is missing lon/lat/chunk data.");
}

const sampleCols = buildSampleIndices(lon.length, stride);
const sampledLon = sampleCols.map((index) => lon[index]);
const sampledLat = [];
const sampledZ = [];

let globalRow = 0;
for (const chunkFile of chunkFiles) {
  const chunkPath = path.join(repoRoot, "public/data", chunkFile);
  const chunk = JSON.parse(fs.readFileSync(chunkPath, "utf8"));
  const rows = Array.isArray(chunk.z) ? chunk.z : [];
  for (let rowOffset = 0; rowOffset < rows.length; rowOffset += 1) {
    const absoluteRow = globalRow + rowOffset;
    if (absoluteRow % stride !== 0 && absoluteRow !== lat.length - 1) continue;
    const row = rows[rowOffset];
    if (!Array.isArray(row)) continue;
    sampledLat.push(lat[absoluteRow]);
    sampledZ.push(sampleCols.map((column) => Number(row[column])));
  }
  globalRow += rows.length;
}

if (!sampledLat.length || !sampledZ.length) {
  throw new Error("Failed to sample any RTopo rows.");
}

const smoothedZ = smoothGrid(sampledZ, smoothPasses);

let minZ = Number.POSITIVE_INFINITY;
let maxZ = Number.NEGATIVE_INFINITY;
for (const row of smoothedZ) {
  for (const value of row) {
    if (!Number.isFinite(value)) continue;
    minZ = Math.min(minZ, value);
    maxZ = Math.max(maxZ, value);
  }
}
if (!Number.isFinite(minZ) || !Number.isFinite(maxZ) || maxZ <= minZ) {
  throw new Error("Invalid elevation range in sampled RTopo grid.");
}

const lonMin = sampledLon[0];
const lonMax = sampledLon[sampledLon.length - 1];
const latMin = sampledLat[0];
const latMax = sampledLat[sampledLat.length - 1];
const lonSpan = Math.max(1e-9, lonMax - lonMin);
const latSpan = Math.max(1e-9, latMax - latMin);
const meanLatRad = ((latMin + latMax) * 0.5 * Math.PI) / 180;
const xKm = Math.max(1e-9, lonSpan * Math.cos(meanLatRad) * 111.32);
const yKm = Math.max(1e-9, latSpan * 111.32);
const meshWidth = BASE_MESH_WIDTH;
const meshHeight = BASE_MESH_WIDTH * (yKm / xKm);
const verticalScale = BASE_Z_SCALE * depthRatio;

const lonToX = (value) => ((value - lonMin) / lonSpan - 0.5) * meshWidth;
const latToY = (value) => ((value - latMin) / latSpan - 0.5) * meshHeight;
const scaleElevation = (elevation) =>
  elevation < 0
    ? elevation * verticalScale * OCEAN_RELIEF_FACTOR
    : elevation * verticalScale * LAND_RELIEF_FACTOR;

const points = sampledLat.map((latValue, rowIndex) =>
  sampledLon.map((lonValue, columnIndex) => {
    const elevation = Number(smoothedZ[rowIndex][columnIndex]);
    return new THREE.Vector3(lonToX(lonValue), latToY(latValue), scaleElevation(elevation));
  })
);

let minPointZ = Number.POSITIVE_INFINITY;
let maxPointZ = Number.NEGATIVE_INFINITY;
for (const row of points) {
  for (const point of row) {
    minPointZ = Math.min(minPointZ, point.z);
    maxPointZ = Math.max(maxPointZ, point.z);
  }
}
const centerZ = (minPointZ + maxPointZ) * 0.5;
const halfDepth = Math.max(1e-9, (maxPointZ - minPointZ) * 0.5);
const domainRadius = Math.max(1, Math.hypot(meshWidth * 0.5, meshHeight * 0.5, halfDepth));
const frameTarget = new THREE.Vector3(-domainRadius * 0.035, 0, centerZ);

const camera = new THREE.PerspectiveCamera(42, canvasAspect, 1, 45000);
camera.up.set(0, 0, 1);

const fovRad = THREE.MathUtils.degToRad(camera.fov);
const hFovRad = 2 * Math.atan(Math.tan(fovRad * 0.5) * Math.max(1e-4, camera.aspect || 1));
const fitDist = Math.max(
  domainRadius / Math.max(1e-4, Math.sin(fovRad * 0.5)),
  domainRadius / Math.max(1e-4, Math.sin(hFovRad * 0.5))
);
camera.position.copy(frameTarget.clone().addScaledVector(DEFAULT_CAMERA_DIRECTION, fitDist * 0.8));
camera.lookAt(frameTarget);
camera.updateMatrixWorld(true);

const projectionCanvasWidth = 1308;
const projectionCanvasHeight = Math.round(projectionCanvasWidth / canvasAspect);

const oceanPalette = makeLinearPalette(OCEAN_STOPS, 256);
const landPalette = makeLinearPalette(LAND_STOPS, 256);
const cameraView = camera.matrixWorldInverse.clone();
const faces = [];

function projectToScreen(point) {
  const ndc = point.clone().project(camera);
  return {
    x: (ndc.x * 0.5 + 0.5) * projectionCanvasWidth,
    y: (-ndc.y * 0.5 + 0.5) * projectionCanvasHeight,
    z: ndc.z,
  };
}

function sampleElevationColor(elevation) {
  if (elevation <= 0) {
    const t = clamp((elevation - minZ) / Math.max(1e-9, -minZ), 0, 1);
    return samplePalette(oceanPalette, t);
  }
  const t = clamp(elevation / Math.max(1e-9, maxZ), 0, 1);
  return samplePalette(landPalette, t);
}

function pushFace(worldPoints, zAverage, faceType) {
  const normal =
    worldPoints.length === 4
      ? faceNormal(worldPoints[0], worldPoints[1], worldPoints[3])
      : faceNormal(worldPoints[0], worldPoints[1], worldPoints[2]);
  if (!normal) return;
  const center = new THREE.Vector3(0, 0, 0);
  for (const point of worldPoints) center.add(point);
  center.multiplyScalar(1 / worldPoints.length);
  const toCamera = camera.position.clone().sub(center);
  if (normal.dot(toCamera) <= 0) return;

  const cameraPoints = worldPoints.map((point) => point.clone().applyMatrix4(cameraView));
  if (cameraPoints.some((point) => !Number.isFinite(point.z) || point.z > -1)) return;

  const screenPoints = worldPoints.map(projectToScreen);
  if (
    screenPoints.some(
      (point) =>
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !Number.isFinite(point.z) ||
        Math.abs(point.x) > projectionCanvasWidth * 4 ||
        Math.abs(point.y) > projectionCanvasHeight * 4
    )
  ) {
    return;
  }

  const brightness = faceType === "wall" ? lambertBrightness(normal, center, camera.position) * 0.88 : lambertBrightness(normal, center, camera.position);
  const baseColor = sampleElevationColor(zAverage);
  const fill = rgbToHex(applyShade(baseColor, brightness));
  const cameraZ = center.clone().applyMatrix4(cameraView).z;
  faces.push({
    fill,
    depth: cameraZ,
    points: screenPoints,
  });
}

for (let row = 0; row < points.length - 1; row += 1) {
  for (let column = 0; column < points[row].length - 1; column += 1) {
    const p00 = points[row][column];
    const p10 = points[row][column + 1];
    const p11 = points[row + 1][column + 1];
    const p01 = points[row + 1][column];
    const rawAverage =
      (smoothedZ[row][column] +
        smoothedZ[row][column + 1] +
        smoothedZ[row + 1][column + 1] +
        smoothedZ[row + 1][column]) /
      4;
    pushFace([p00, p10, p11, p01], rawAverage, "surface");
  }
}

if (!faces.length) {
  throw new Error("No visible faces were generated.");
}

faces.sort((left, right) => left.depth - right.depth);

let minX = Number.POSITIVE_INFINITY;
let minY = Number.POSITIVE_INFINITY;
let maxX = Number.NEGATIVE_INFINITY;
let maxY = Number.NEGATIVE_INFINITY;
for (const face of faces) {
  for (const point of face.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
}

const margin = 18;
const colorbarWidth = 28;
const colorbarGap = 26;
const colorbarLabelGap = 10;
const colorbarRightPad = 54;
const svgWidth = Math.ceil(maxX - minX + margin * 2);
const svgHeight = Math.ceil(maxY - minY + margin * 2);
const offsetX = minX - margin;
const offsetY = minY - margin;
const finalWidth = svgWidth + colorbarGap + colorbarWidth + colorbarLabelGap + colorbarRightPad;

const pathElements = faces.map(
  (face) =>
    `  <path fill="${face.fill}" stroke="${face.fill}" stroke-width="0.38" stroke-linejoin="round" paint-order="stroke fill" d="${pathForPoints(face.points, offsetX, offsetY)}"/>`
);

function makeLegendTicks(min, max) {
  const raw = [min, -4000, -3000, -2000, -1000, 0, 500, 1000, 2000, max];
  return raw.filter((value, index, array) => Number.isFinite(value) && value >= min - 1e-9 && value <= max + 1e-9 && array.indexOf(value) === index);
}

const legendTicks = makeLegendTicks(minZ, maxZ);
const zeroOffset = clamp((0 - minZ) / Math.max(1e-9, maxZ - minZ), 0, 1);
const oceanGradientStops = OCEAN_STOPS.map((color, index) => {
  const t = (index / Math.max(1, OCEAN_STOPS.length - 1)) * zeroOffset;
  return `      <stop offset="${(t * 100).toFixed(2)}%" stop-color="${color}"/>`;
});
const landGradientStops = LAND_STOPS.map((color, index) => {
  const t = zeroOffset + (index / Math.max(1, LAND_STOPS.length - 1)) * (1 - zeroOffset);
  return `      <stop offset="${(t * 100).toFixed(2)}%" stop-color="${color}"/>`;
});
const gradientStops = [...oceanGradientStops, ...landGradientStops].join("\n");
const colorbarX = svgWidth + colorbarGap;
const colorbarY = 48;
const colorbarHeight = Math.max(240, svgHeight - 96);
const legendTickElements = legendTicks
  .map((value) => {
    const t = clamp((value - minZ) / Math.max(1e-9, maxZ - minZ), 0, 1);
    const y = colorbarY + (1 - t) * colorbarHeight;
    return [
      `  <line x1="${(colorbarX + colorbarWidth).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(colorbarX + colorbarWidth + 7).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#4b5563" stroke-width="1"/>`,
      `  <text x="${(colorbarX + colorbarWidth + 12).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="13" fill="#334155">${formatTick(value)}</text>`,
    ].join("\n");
  })
  .join("\n");

const metadata = [
  `Generated from public/data/RTopo_30arcsec.json`,
  `stride=${stride}`,
  `depthRatio=${depthRatio}`,
  `smoothPasses=${smoothPasses}`,
  `landReliefFactor=${LAND_RELIEF_FACTOR}`,
  `elevationRange=${minZ.toFixed(2)}..${maxZ.toFixed(2)}`,
  `faces=${faces.length}`,
].join(" | ");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${finalWidth}" height="${svgHeight}" viewBox="0 0 ${finalWidth} ${svgHeight}" role="img" aria-labelledby="title desc">
  <title id="title">Nordic Seas RTopo bathymetry and topography</title>
  <desc id="desc">${metadata}</desc>
  <metadata>${metadata}</metadata>
  <defs>
    <linearGradient id="elevation-scale" x1="0" y1="1" x2="0" y2="0">
${gradientStops}
    </linearGradient>
  </defs>
${pathElements.join("\n")}
  <g aria-label="Elevation colorbar">
    <text x="${colorbarX.toFixed(1)}" y="26" font-size="15" font-weight="600" fill="#1f2937">Elevation (m)</text>
    <rect x="${colorbarX.toFixed(1)}" y="${colorbarY.toFixed(1)}" width="${colorbarWidth}" height="${colorbarHeight.toFixed(1)}" fill="url(#elevation-scale)" rx="3"/>
    <rect x="${colorbarX.toFixed(1)}" y="${colorbarY.toFixed(1)}" width="${colorbarWidth}" height="${colorbarHeight.toFixed(1)}" fill="none" stroke="#94a3b8" stroke-width="0.8" rx="3"/>
${legendTickElements}
  </g>
</svg>
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, svg);

const renderPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nordic Bathymetry Render</title>
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #ff00ff;
    }
    body {
      display: grid;
      place-items: center;
    }
    canvas {
      display: block;
      width: ${projectionCanvasWidth}px;
      height: ${projectionCanvasHeight}px;
      background: transparent;
    }
  </style>
</head>
<body>
  <canvas id="terrain" width="${projectionCanvasWidth}" height="${projectionCanvasHeight}"></canvas>
  <script type="module">
    import * as THREE from "../../../node_modules/three/build/three.module.js";

    const lon = ${JSON.stringify(sampledLon)};
    const lat = ${JSON.stringify(sampledLat)};
    const z = ${JSON.stringify(smoothedZ)};
    const oceanStops = ${JSON.stringify(OCEAN_STOPS)};
    const landStops = ${JSON.stringify(LAND_STOPS)};
    const meshWidth = ${JSON.stringify(meshWidth)};
    const meshHeight = ${JSON.stringify(meshHeight)};
    const verticalScale = ${JSON.stringify(verticalScale)};
    const minZ = ${JSON.stringify(minZ)};
    const maxZ = ${JSON.stringify(maxZ)};
    const projectionCanvasWidth = ${JSON.stringify(projectionCanvasWidth)};
    const projectionCanvasHeight = ${JSON.stringify(projectionCanvasHeight)};
    const domainRadius = ${JSON.stringify(domainRadius)};
    const centerZ = ${JSON.stringify(centerZ)};
    const canvasAspect = ${JSON.stringify(canvasAspect)};

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function hexToRgb(hex) {
      const normalized = hex.replace("#", "");
      return {
        r: Number.parseInt(normalized.slice(0, 2), 16),
        g: Number.parseInt(normalized.slice(2, 4), 16),
        b: Number.parseInt(normalized.slice(4, 6), 16),
      };
    }

    function mixRgb(a, b, t) {
      return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
      };
    }

    function makeLinearPalette(hexStops, count) {
      const stops = hexStops.map(hexToRgb);
      const segments = Math.max(1, stops.length - 1);
      return Array.from({ length: count }, (_, index) => {
        const t = index / Math.max(1, count - 1);
        const scaled = t * segments;
        const low = Math.min(segments - 1, Math.floor(scaled));
        const local = scaled - low;
        return mixRgb(stops[low], stops[low + 1], local);
      });
    }

    const oceanPalette = makeLinearPalette(oceanStops, 256);
    const landPalette = makeLinearPalette(landStops, 256);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, canvasAspect, 1, 45000);
    camera.up.set(0, 0, 1);

    const frameTarget = new THREE.Vector3(-domainRadius * 0.035, 0, centerZ);
    const direction = new THREE.Vector3(0.0, -0.88, 0.72).normalize();
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const hFovRad = 2 * Math.atan(Math.tan(fovRad * 0.5) * Math.max(1e-4, camera.aspect || 1));
    const fitDist = Math.max(
      domainRadius / Math.max(1e-4, Math.sin(fovRad * 0.5)),
      domainRadius / Math.max(1e-4, Math.sin(hFovRad * 0.5))
    );
    camera.position.copy(frameTarget.clone().addScaledVector(direction, fitDist * 0.8));
    camera.lookAt(frameTarget);

    const renderer = new THREE.WebGLRenderer({
      canvas: document.getElementById("terrain"),
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(1);
    renderer.setSize(projectionCanvasWidth, projectionCanvasHeight, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const hemi = new THREE.HemisphereLight(0xfafcff, 0xe2edf7, 1.05);
    hemi.position.set(0, 0, 1);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(-220, -260, 380);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xb8dfff, 0.48);
    fill.position.set(280, 180, 120);
    scene.add(fill);

    const nx = lon.length;
    const ny = lat.length;
    const lonMin = lon[0];
    const lonMax = lon[nx - 1];
    const latMin = lat[0];
    const latMax = lat[ny - 1];
    const lonSpan = Math.max(1e-9, lonMax - lonMin);
    const latSpan = Math.max(1e-9, latMax - latMin);
    const lonToX = (value) => ((value - lonMin) / lonSpan - 0.5) * meshWidth;
    const latToY = (value) => ((value - latMin) / latSpan - 0.5) * meshHeight;

    const geometry = new THREE.PlaneGeometry(meshWidth, meshHeight, nx - 1, ny - 1);
    const position = geometry.attributes.position;
    const colors = new Float32Array(nx * ny * 3);

    for (let row = 0; row < ny; row += 1) {
      const geomRow = ny - 1 - row;
      const y = latToY(lat[row]);
      for (let column = 0; column < nx; column += 1) {
        const index = geomRow * nx + column;
        const elevation = Number(z[row][column]);
        const color =
          elevation <= 0
            ? oceanPalette[Math.round(clamp((elevation - minZ) / Math.max(1e-9, -minZ), 0, 1) * (oceanPalette.length - 1))]
            : landPalette[Math.round(clamp(elevation / Math.max(1e-9, maxZ), 0, 1) * (landPalette.length - 1))];
        position.setX(index, lonToX(lon[column]));
        position.setY(index, y);
        position.setZ(index, elevation);
        colors[index * 3] = color.r / 255;
        colors[index * 3 + 1] = color.g / 255;
        colors[index * 3 + 2] = color.b / 255;
      }
    }

    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      roughness: 0.94,
      metalness: 0.05,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.z = verticalScale;
    scene.add(mesh);

    renderer.render(scene, camera);
    document.documentElement.dataset.rendered = "true";
  </script>
</body>
</html>
`;

fs.writeFileSync(renderPagePath, renderPage);

console.log(`Saved ${path.relative(repoRoot, outputPath)}`);
console.log(`Saved ${path.relative(repoRoot, renderPagePath)}`);
console.log(`Canvas ${svgWidth}x${svgHeight}`);
console.log(`Elevation range ${minZ.toFixed(2)}..${maxZ.toFixed(2)}`);
console.log(`Faces ${faces.length}`);
