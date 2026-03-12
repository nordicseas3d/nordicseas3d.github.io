export type EddyKind = "warm" | "cold";

export type EddyFrameInput = {
  timeIndex: number;
  values: number[][];
};

export type EddyCluster = {
  id: string;
  kind: EddyKind;
  timeIndex: number;
  centroidLon: number;
  centroidLat: number;
  meanValue: number;
  meanAnomaly: number;
  peakAnomaly: number;
  radiusKm: number;
  cellCount: number;
  x: number[];
  y: number[];
  sampleCells: Array<{ j: number; i: number }>;
  trackX?: number[];
  trackY?: number[];
};

export type EddyDetectionResult = {
  threshold: number;
  blurRadiusX: number;
  blurRadiusY: number;
  clusters: EddyCluster[];
};

type DetectOpts = {
  zeroAsMissing?: boolean;
  minCells?: number;
  sampleCap?: number;
  threshold?: number;
  thresholdFloor?: number;
  trackHistory?: number;
};

type ClusterBase = Omit<EddyCluster, "trackX" | "trackY">;

export type EddyVolumeCluster = {
  id: string;
  kind: EddyKind;
  x: number[];
  y: number[];
  z: number[];
  meanValue: number;
  minDepth: number;
  maxDepth: number;
  pointCount: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function quantile(values: number[], q: number) {
  if (!values.length) return Number.NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const t = clamp(q, 0, 1) * (sorted.length - 1);
  const i0 = Math.floor(t);
  const i1 = Math.min(sorted.length - 1, i0 + 1);
  const f = t - i0;
  return sorted[i0] * (1 - f) + sorted[i1] * f;
}

function averageStep(values: number[]) {
  if (values.length < 2) return 1;
  let total = 0;
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = Math.abs(Number(values[i]) - Number(values[i - 1]));
    if (!Number.isFinite(delta) || delta <= 0) continue;
    total += delta;
    count += 1;
  }
  return count ? total / count : 1;
}

function sampleIndices(length: number, targetCount: number) {
  if (!Number.isFinite(length) || length <= 0) return [];
  if (!Number.isFinite(targetCount) || targetCount <= 0 || targetCount >= length) {
    return Array.from({ length }, (_, i) => i);
  }
  const n = Math.max(2, Math.min(length, Math.round(targetCount)));
  if (n >= length) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (n - 1);
  const out: number[] = [];
  let prev = -1;
  for (let k = 0; k < n; k++) {
    const idx = Math.round(k * step);
    if (idx === prev) continue;
    out.push(idx);
    prev = idx;
  }
  if (out[0] !== 0) out.unshift(0);
  if (out[out.length - 1] !== length - 1) out.push(length - 1);
  return out;
}

function makeBlurPass(values: number[][], radius: number, axis: "x" | "y") {
  const ny = values.length;
  const nx = values[0]?.length ?? 0;
  const sums: number[][] = Array.from({ length: ny }, () => new Array(nx).fill(Number.NaN));
  const counts: number[][] = Array.from({ length: ny }, () => new Array(nx).fill(0));

  if (!nx || !ny) return { sums, counts };

  if (axis === "x") {
    for (let j = 0; j < ny; j++) {
      const prefixSum = new Array(nx + 1).fill(0);
      const prefixCount = new Array(nx + 1).fill(0);
      for (let i = 0; i < nx; i++) {
        const v = Number(values[j][i]);
        const valid = Number.isFinite(v);
        prefixSum[i + 1] = prefixSum[i] + (valid ? v : 0);
        prefixCount[i + 1] = prefixCount[i] + (valid ? 1 : 0);
      }
      for (let i = 0; i < nx; i++) {
        const i0 = Math.max(0, i - radius);
        const i1 = Math.min(nx - 1, i + radius);
        const count = prefixCount[i1 + 1] - prefixCount[i0];
        counts[j][i] = count;
        sums[j][i] = count ? prefixSum[i1 + 1] - prefixSum[i0] : Number.NaN;
      }
    }
    return { sums, counts };
  }

  for (let i = 0; i < nx; i++) {
    const prefixSum = new Array(ny + 1).fill(0);
    const prefixCount = new Array(ny + 1).fill(0);
    for (let j = 0; j < ny; j++) {
      const v = Number(values[j][i]);
      const valid = Number.isFinite(v);
      prefixSum[j + 1] = prefixSum[j] + (valid ? v : 0);
      prefixCount[j + 1] = prefixCount[j] + (valid ? 1 : 0);
    }
    for (let j = 0; j < ny; j++) {
      const j0 = Math.max(0, j - radius);
      const j1 = Math.min(ny - 1, j + radius);
      const count = prefixCount[j1 + 1] - prefixCount[j0];
      counts[j][i] = count;
      sums[j][i] = count ? prefixSum[j1 + 1] - prefixSum[j0] : Number.NaN;
    }
  }
  return { sums, counts };
}

function blur2D(values: number[][], radiusX: number, radiusY: number) {
  const passX = makeBlurPass(values, radiusX, "x");
  const avgX = passX.sums.map((row, j) =>
    row.map((sum, i) => {
      const count = passX.counts[j][i];
      return count ? sum / count : Number.NaN;
    })
  );
  const passY = makeBlurPass(avgX, radiusY, "y");
  return passY.sums.map((row, j) =>
    row.map((sum, i) => {
      const count = passY.counts[j][i];
      return count ? sum / count : Number.NaN;
    })
  );
}

function distanceKm(lonA: number, latA: number, lonB: number, latB: number) {
  const meanLatRad = ((latA + latB) * 0.5 * Math.PI) / 180;
  const dx = (lonA - lonB) * 111.32 * Math.cos(meanLatRad);
  const dy = (latA - latB) * 111.32;
  return Math.sqrt(dx * dx + dy * dy);
}

function sampleComponentCells(
  cells: Array<{ j: number; i: number }>,
  sampleCap: number,
  lon: number[],
  lat: number[]
) {
  if (cells.length <= sampleCap) {
    return {
      x: cells.map((cell) => Number(lon[cell.i])),
      y: cells.map((cell) => Number(lat[cell.j])),
      sampleCells: cells.map((cell) => ({ j: cell.j, i: cell.i })),
    };
  }
  const step = (cells.length - 1) / Math.max(1, sampleCap - 1);
  const x: number[] = [];
  const y: number[] = [];
  const sampleCells: Array<{ j: number; i: number }> = [];
  let prev = -1;
  for (let k = 0; k < sampleCap; k++) {
    const idx = Math.round(k * step);
    if (idx === prev) continue;
    prev = idx;
    const cell = cells[idx];
    x.push(Number(lon[cell.i]));
    y.push(Number(lat[cell.j]));
    sampleCells.push({ j: cell.j, i: cell.i });
  }
  return { x, y, sampleCells };
}

export function computeAnomalyField(
  values: number[][],
  lon: number[],
  lat: number[],
  opts: Pick<DetectOpts, "zeroAsMissing" | "threshold" | "thresholdFloor">
) {
  const ny = values.length;
  const nx = values[0]?.length ?? 0;
  const radiusX = clamp(Math.round(nx / 20), 3, 14);
  const radiusY = clamp(Math.round(ny / 20), 3, 14);
  const cleaned = values.map((row) =>
    row.map((value) => {
      const v = Number(value);
      if (!Number.isFinite(v)) return Number.NaN;
      if (opts.zeroAsMissing && v === 0) return Number.NaN;
      return v;
    })
  );
  const blurred = blur2D(cleaned, radiusX, radiusY);
  const anomaly = cleaned.map((row, j) =>
    row.map((value, i) => {
      const bg = Number(blurred[j][i]);
      if (!Number.isFinite(value) || !Number.isFinite(bg)) return Number.NaN;
      return value - bg;
    })
  );

  const absAnomalies: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = Math.abs(Number(anomaly[j][i]));
      if (Number.isFinite(a)) absAnomalies.push(a);
    }
  }
  const q75 = quantile(absAnomalies, 0.75);
  const q88 = quantile(absAnomalies, 0.88);
  const manualThreshold = Number(opts.threshold);
  const threshold =
    Number.isFinite(manualThreshold) && manualThreshold > 0
      ? manualThreshold
      : Math.max(opts.thresholdFloor ?? 0, q75, q88 * 0.7);

  const dxKm = Math.max(0.5, averageStep(lon) * 111.32 * Math.cos((quantile(lat, 0.5) * Math.PI) / 180));
  const dyKm = Math.max(0.5, averageStep(lat) * 111.32);

  return {
    cleaned,
    anomaly,
    threshold,
    blurRadiusX: radiusX,
    blurRadiusY: radiusY,
    dxKm,
    dyKm,
  };
}

function detectFrameEddies(
  frame: EddyFrameInput,
  lon: number[],
  lat: number[],
  opts: DetectOpts
) {
  const ny = frame.values.length;
  const nx = frame.values[0]?.length ?? 0;
  const sampleCap = Math.max(60, opts.sampleCap ?? 240);
  const minCells = Math.max(6, opts.minCells ?? Math.round((nx * ny) / 5000));
  const { cleaned, anomaly, threshold, blurRadiusX: radiusX, blurRadiusY: radiusY, dxKm, dyKm } =
    computeAnomalyField(frame.values, lon, lat, opts);
  const cellAreaKm2 = dxKm * dyKm;

  const detectKind = (kind: EddyKind) => {
    const positive = kind === "warm";
    const visited = Array.from({ length: ny }, () => new Uint8Array(nx));
    const out: ClusterBase[] = [];
    const neighbors = [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1],           [0, 1],
      [1, -1],  [1, 0],  [1, 1],
    ];

    for (let j0 = 0; j0 < ny; j0++) {
      for (let i0 = 0; i0 < nx; i0++) {
        if (visited[j0][i0]) continue;
        const a0 = Number(anomaly[j0][i0]);
        if (!Number.isFinite(a0) || (positive ? a0 < threshold : a0 > -threshold)) continue;

        const queue = [{ j: j0, i: i0 }];
        visited[j0][i0] = 1;
        const cells: Array<{ j: number; i: number }> = [];
        let weightSum = 0;
        let lonSum = 0;
        let latSum = 0;
        let anomalySum = 0;
        let valueSum = 0;
        let peakAnomaly = 0;

        while (queue.length) {
          const cell = queue.pop()!;
          cells.push(cell);
          const value = Number(cleaned[cell.j][cell.i]);
          const anomalyValue = Number(anomaly[cell.j][cell.i]);
          const weight = Math.abs(anomalyValue);
          weightSum += weight;
          lonSum += Number(lon[cell.i]) * weight;
          latSum += Number(lat[cell.j]) * weight;
          anomalySum += anomalyValue;
          valueSum += value;
          peakAnomaly = Math.max(peakAnomaly, Math.abs(anomalyValue));

          for (let n = 0; n < neighbors.length; n++) {
            const nextJ = cell.j + neighbors[n][0];
            const nextI = cell.i + neighbors[n][1];
            if (nextJ < 0 || nextJ >= ny || nextI < 0 || nextI >= nx) continue;
            if (visited[nextJ][nextI]) continue;
            const nextA = Number(anomaly[nextJ][nextI]);
            if (!Number.isFinite(nextA) || (positive ? nextA < threshold : nextA > -threshold)) continue;
            visited[nextJ][nextI] = 1;
            queue.push({ j: nextJ, i: nextI });
          }
        }

        if (cells.length < minCells) continue;

        const centroidLon = weightSum ? lonSum / weightSum : Number(lon[i0]);
        const centroidLat = weightSum ? latSum / weightSum : Number(lat[j0]);
        const sampled = sampleComponentCells(cells, sampleCap, lon, lat);
        const radiusKm = Math.sqrt((cells.length * cellAreaKm2) / Math.PI);
        out.push({
          id: `${kind}-${frame.timeIndex}-${out.length + 1}`,
          kind,
          timeIndex: frame.timeIndex,
          centroidLon,
          centroidLat,
          meanValue: valueSum / cells.length,
          meanAnomaly: anomalySum / cells.length,
          peakAnomaly: positive ? peakAnomaly : -peakAnomaly,
          radiusKm,
          cellCount: cells.length,
          x: sampled.x,
          y: sampled.y,
          sampleCells: sampled.sampleCells,
        });
      }
    }

    return out.sort((a, b) => b.cellCount - a.cellCount);
  };

  return {
    threshold,
    blurRadiusX: radiusX,
    blurRadiusY: radiusY,
    clusters: [...detectKind("warm"), ...detectKind("cold")],
  };
}

export function detectAndTrackEddies(
  frames: EddyFrameInput[],
  lon: number[],
  lat: number[],
  opts: DetectOpts = {}
): EddyDetectionResult {
  if (!frames.length) {
    return { threshold: Number.NaN, blurRadiusX: 0, blurRadiusY: 0, clusters: [] };
  }

  const detections = frames.map((frame) => detectFrameEddies(frame, lon, lat, opts));
  const history = Math.max(1, Math.min(frames.length, opts.trackHistory ?? frames.length));
  const currentIndex = frames.length - 1;
  const currentDetection = detections[currentIndex];
  const startIndex = Math.max(0, currentIndex - history + 1);

  const clusters = currentDetection.clusters.map((cluster) => {
    const trackX = [cluster.centroidLon];
    const trackY = [cluster.centroidLat];
    let ref = cluster;

    for (let frameIndex = currentIndex - 1; frameIndex >= startIndex; frameIndex--) {
      let best: ClusterBase | null = null;
      let bestDistance = Infinity;
      const candidates = detections[frameIndex].clusters;
      for (let c = 0; c < candidates.length; c++) {
        const candidate = candidates[c];
        if (candidate.kind !== cluster.kind) continue;
        const distance = distanceKm(
          candidate.centroidLon,
          candidate.centroidLat,
          ref.centroidLon,
          ref.centroidLat
        );
        const limit = Math.max(110, Math.min(320, Math.max(ref.radiusKm, candidate.radiusKm) * 4));
        if (distance > limit || distance >= bestDistance) continue;
        best = candidate;
        bestDistance = distance;
      }
      if (!best) continue;
      trackX.unshift(best.centroidLon);
      trackY.unshift(best.centroidLat);
      ref = best;
    }

    return {
      ...cluster,
      trackX,
      trackY,
    };
  });

  return {
    threshold: currentDetection.threshold,
    blurRadiusX: currentDetection.blurRadiusX,
    blurRadiusY: currentDetection.blurRadiusY,
    clusters,
  };
}

export function buildEddyVolume(opts: {
  data: Float32Array;
  nz: number;
  ny: number;
  nx: number;
  lon: number[];
  lat: number[];
  z: number[];
  clusters: EddyCluster[];
  zeroAsMissing?: boolean;
  threshold?: number;
  thresholdFloor?: number;
  depthSampleCount?: number;
  pointCapPerCluster?: number;
}): EddyVolumeCluster[] {
  if (!opts.clusters.length || !opts.nz || !opts.ny || !opts.nx) return [];

  const depthIndices = sampleIndices(opts.nz, Math.max(8, opts.depthSampleCount ?? opts.nz));
  const pointCap = Math.max(120, opts.pointCapPerCluster ?? 900);
  const accum = opts.clusters.map((cluster, index) => ({
    id: cluster.id,
    kind: cluster.kind,
    x: [] as number[],
    y: [] as number[],
    z: [] as number[],
    seen: 0,
    rand: ((index + 1) * 2654435761 + (cluster.timeIndex + 1) * 2246822519) >>> 0,
    valueSum: 0,
    pointCount: 0,
    minDepth: Infinity,
    maxDepth: -Infinity,
  }));

  for (let dk = 0; dk < depthIndices.length; dk++) {
    const k = depthIndices[dk];
    const offset = k * opts.ny * opts.nx;
    const slice: number[][] = new Array(opts.ny);
    let p = offset;
    for (let j = 0; j < opts.ny; j++) {
      const row: number[] = new Array(opts.nx);
      for (let i = 0; i < opts.nx; i++) row[i] = Number(opts.data[p++]);
      slice[j] = row;
    }
    const anomalyField = computeAnomalyField(slice, opts.lon, opts.lat, {
      zeroAsMissing: opts.zeroAsMissing,
      threshold: opts.threshold,
      thresholdFloor: opts.thresholdFloor,
    });

    for (let c = 0; c < opts.clusters.length; c++) {
      const cluster = opts.clusters[c];
      const bucket = accum[c];
      const manualThreshold = Number(opts.threshold);
      const threshold =
        Number.isFinite(manualThreshold) && manualThreshold > 0
          ? manualThreshold
          : Math.max(opts.thresholdFloor ?? 0, Math.abs(cluster.meanAnomaly) * 0.45, anomalyField.threshold * 0.55);
      const positive = cluster.kind === "warm";
      for (let n = 0; n < cluster.sampleCells.length; n++) {
        const cell = cluster.sampleCells[n];
        const value = Number(anomalyField.cleaned[cell.j]?.[cell.i]);
        const anomaly = Number(anomalyField.anomaly[cell.j]?.[cell.i]);
        if (!Number.isFinite(value) || !Number.isFinite(anomaly)) continue;
        if (positive ? anomaly < threshold : anomaly > -threshold) continue;
        bucket.seen += 1;
        bucket.valueSum += value;
        bucket.pointCount += 1;
        const lon = Number(opts.lon[cell.i]);
        const lat = Number(opts.lat[cell.j]);
        const depth = Number(opts.z[k]);
        bucket.minDepth = Math.min(bucket.minDepth, depth);
        bucket.maxDepth = Math.max(bucket.maxDepth, depth);

        if (bucket.x.length < pointCap) {
          bucket.x.push(lon);
          bucket.y.push(lat);
          bucket.z.push(depth);
          continue;
        }
        bucket.rand = (1664525 * bucket.rand + 1013904223) >>> 0;
        const replace = bucket.rand % bucket.seen;
        if (replace < pointCap) {
          bucket.x[replace] = lon;
          bucket.y[replace] = lat;
          bucket.z[replace] = depth;
        }
      }
    }
  }

  return accum
    .filter((bucket) => bucket.x.length > 0 && bucket.pointCount > 0)
    .map((bucket) => ({
      id: bucket.id,
      kind: bucket.kind,
      x: bucket.x,
      y: bucket.y,
      z: bucket.z,
      meanValue: bucket.valueSum / bucket.pointCount,
      minDepth: bucket.minDepth,
      maxDepth: bucket.maxDepth,
      pointCount: bucket.pointCount,
    }));
}
