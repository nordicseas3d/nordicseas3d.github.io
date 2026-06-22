"""
save_rtopo_bathy.py
===================
Save the Nordic RTopo-2.0.4 30" bathymetry for the web viewer at a tiny fraction
of the current size.

Why the JSON is huge (and most of it is wasted)
-----------------------------------------------
The viewer renders bathymetry as a Plotly surface / Three mesh that is capped at
~250k points (Plotly, Basemap3D.tsx) and ~70k vertices (Three, BasemapThree.tsx).
It downsamples *on the client, after downloading the whole file*. So shipping the
full ~18M-point 30" grid as JSON float64 (~300 MB, split into 5 chunks) makes no
visible difference -- every point beyond the cap is discarded in the browser.

Fix: pre-downsample to the viewer's cap and store integer metres. Measured
bytes/value (zlib as a zstd proxy):

    JSON float64 ........ 20.3   <- what you have now
    JSON integer metres .  7.0   (GitHub Pages gzips to ~1.9 on the wire)  <- no app change
    binary int16 ........  2.0
    int16 + zstd ........  1.1   (smallest, but needs a loader change)

At ~213k points (the Plotly cap) that's ~1.5 MB JSON / ~0.4 MB gzipped, versus
~300 MB today: a ~150x reduction, no visible change, and no code change because
the loader already accepts an inline {lon, lat, z}. You can also delete the old
RTopo_30arcsec.chunk-*.json files afterwards.
"""

import json
import os
import numpy as np


def save_rtopo_bathy(da, path="RTopo_30arcsec.json", max_points=250_000):
    """Downsample a 2-D bedrock DataArray and write a single {lon, lat, z} JSON
    with z as integer metres.

    Parameters
    ----------
    da : xarray.DataArray
        2-D bed elevation with 1-D lon/lat coords (e.g. ``RTopo2_nordic``).
    path : str
        Output JSON path (overwrite ``RTopo_30arcsec.json``; no chunks needed).
    max_points : int
        Target grid size; 250_000 matches the viewer's Plotly cap, so the result
        is as sharp as the app can ever display.
    """
    ydim, xdim = da.dims  # typically ("lat", "lon")

    # block-mean coarsen so the grid lands at/under the viewer's point cap
    # (mean is anti-aliased; use .isel(::k) striding instead if you prefer
    #  to match the app's exact downsampling)
    k = max(1, int(np.ceil(np.sqrt(da.size / max_points))))
    da_ds = da.coarsen({ydim: k, xdim: k}, boundary="trim").mean()

    lon = np.asarray(da_ds[xdim].values, dtype=float)
    lat = np.asarray(da_ds[ydim].values, dtype=float)
    z = np.rint(da_ds.values)
    z = np.where(np.isfinite(z), z, 0).astype(np.int32)  # integer metres

    payload = {"lon": lon.tolist(), "lat": lat.tolist(), "z": z.tolist()}
    with open(path, "w") as f:
        json.dump(payload, f, separators=(",", ":"))  # compact: no spaces

    mb = os.path.getsize(path) / 1e6
    print(f"wrote {path}: grid {z.shape} ({z.size/1e3:.0f}k pts), "
          f"{mb:.2f} MB on disk (downsample {k}x)")
    return da_ds


if __name__ == "__main__":
    print(__doc__)
