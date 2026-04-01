import { withBase } from "./paths";

export type BathyGrid = {
  lon: number[];
  lat: number[];
  z: number[][];
  zRaw?: number[][];
};

type BathyManifest = {
  lon?: unknown;
  lat?: unknown;
  z?: unknown;
  chunks?: unknown;
};

function parsePossiblyNonStandardJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const normalized = text
      .replace(/\bNaN\b/g, "null")
      .replace(/\b-Infinity\b/g, "null")
      .replace(/\bInfinity\b/g, "null");
    return JSON.parse(normalized) as T;
  }
}

function normalize2DArray(data: unknown): number[][] | null {
  if (!Array.isArray(data)) return null;
  return data.map((row) => (Array.isArray(row) ? row.map((v) => Number(v)) : []));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return parsePossiblyNonStandardJson<T>(await response.text());
}

function toAbsoluteUrl(url: string) {
  if (typeof window === "undefined") return url;
  return new URL(url, window.location.href).toString();
}

function resolveRelativeUrl(baseUrl: string, relativePath: string) {
  return new URL(relativePath, toAbsoluteUrl(baseUrl)).toString();
}

async function loadBathyGridFromUrl(url: string): Promise<BathyGrid | null> {
  const payload = await fetchJson<BathyManifest>(url);
  if (!Array.isArray(payload?.lon) || !Array.isArray(payload?.lat)) return null;
  const lon = payload.lon.map((v) => Number(v));
  const lat = payload.lat.map((v) => Number(v));

  if (Array.isArray(payload.z)) {
    const z = normalize2DArray(payload.z);
    if (!z) return null;
    return { lon, lat, z };
  }

  if (Array.isArray(payload.chunks) && payload.chunks.length) {
    const z: number[][] = [];
    for (const chunkPath of payload.chunks) {
      if (typeof chunkPath !== "string" || !chunkPath.trim()) continue;
      const chunkUrl = resolveRelativeUrl(url, chunkPath);
      const chunkPayload = await fetchJson<{ z?: unknown }>(chunkUrl);
      const chunkZ = normalize2DArray(chunkPayload?.z);
      if (!chunkZ?.length) return null;
      z.push(...chunkZ);
    }
    if (!z.length) return null;
    return { lon, lat, z };
  }

  return null;
}

export async function loadBathyGridFromCandidates(candidates: string[]): Promise<BathyGrid | null> {
  for (const candidate of candidates) {
    try {
      const grid = await loadBathyGridFromUrl(candidate);
      if (grid) return grid;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function bathyCandidates() {
  return {
    model: withBase("data/nordic_model_grid_4.5-1km.json"),
    rtopo: withBase("data/RTopo_30arcsec.json"),
    legacyNordic: withBase("data/nordic.json"),
    legacyGreenlandSea: withBase("data/greenlandsea.json"),
    legacyBathy: withBase("data/bathy.json"),
    legacyRTopoDs: withBase("data/bathy_RTopo_ds.json"),
    legacyRTopo: withBase("data/bathy_RTopo.json"),
  } as const;
}
