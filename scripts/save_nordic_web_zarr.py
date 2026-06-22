"""
save_nordic_web_zarr.py
=======================
Build a small, web-optimised Zarr store for the Nordic Seas viewer.

Why the current store is large
------------------------------
1. `xesmf` regridding returns **float64** -> every field is 2x bigger than it
   needs to be for a viewer.
2. Full float precision is wasted on a colour-mapped 3-D viewer.
3. Chunking must match browser access: one time/depth map slice per request.

Verified relative gains (synthetic 40%-land ocean field, byte-shuffle + entropy
coding; zstd does a bit better still):

    float64 -> float32 ............. ~2.2x smaller
    + bit-round (keepbits ~12) ..... ~2x more, visually lossless
    higher zstd clevel ............. ~10-25% more

The exact result depends on which optional fields are included. Depth-resolved
U/V velocity adds two more 4-D arrays, so a complete current-enabled store will
usually need remote object storage rather than being bundled with GitHub Pages.

Bit-rounding is applied to the *values* (the stored dtype stays float32), so the
browser reader (`zarrita`) needs no changes. int16 packing (bottom of file) is a
touch smaller but requires a small change in the JS loader, so it is opt-in.
"""

import numpy as np
import numcodecs

# Variables the web viewer actually reads (keep this in sync with gsZarr.ts).
WEB_VARS = [
    "T", "S", "rho", "U_cgrid", "V_cgrid",
    "SIarea", "uwind_stress", "vwind_stress", "Eta_noice",
]
COORDS = ["lon", "lat", "Z", "time"]
FIELDS_4D = ["T", "S", "rho", "U_cgrid", "V_cgrid"]  # (time, Z, lat, lon)
FIELDS_3D = ["SIarea", "uwind_stress", "vwind_stress", "Eta_noice"]  # (time, lat, lon)


def bitround(a, keepbits):
    """Zero the low mantissa bits of float32 data (IEEE round-to-nearest).

    float32 has 23 mantissa bits. `keepbits` is how many to keep; the rest are
    zeroed, which makes the data far more compressible while limiting the
    absolute error to ~ value / 2**keepbits. NaNs are preserved.

    Rule of thumb for this viewer: T keepbits=12 (~0.004 degC), S/rho keepbits=14.
    For a principled choice per variable, see the `xbitinfo` package.
    """
    x = np.asarray(a, dtype=np.float32)
    finite = np.isfinite(x)
    xi = x.view(np.int32)
    keep_mask = np.int32(~((1 << (23 - keepbits)) - 1))
    half_ulp = np.int32(1 << (23 - keepbits - 1))
    rounded = ((xi + half_ulp) & keep_mask).view(np.float32)
    out = x.copy()
    out[finite] = rounded[finite]
    return out


def save_nordic_web_zarr(
    ds,
    path="nordic.zarr",
    keepbits=None,        # e.g. {"T": 12, "U_cgrid": 10}; None -> lossless float32
    clevel=5,             # zstd level (3 fast, 5-7 smaller; read speed unaffected)
    chunk_z=1,            # 1 = optimal for the default horizontal-map mode
):
    """Write a web-optimised Zarr store and return the prepared dataset.

    Drops unused variables, casts to float32, optionally bit-rounds the scalars,
    chunks per (time, depth) so a single-depth map slice is one chunk, and
    compresses with Blosc/zstd. Coordinates lon/lat/Z/time are preserved.
    """
    import xarray as xr  # local import so the module loads with numpy only

    if keepbits is None:
        keepbits = {}

    # 1) keep only what the viewer reads
    keep = [v for v in WEB_VARS if v in ds] + [c for c in COORDS if c in ds]
    out = ds[keep]

    # 2) float32 everywhere (xesmf returns float64)
    for v in list(out.data_vars):
        if np.issubdtype(out[v].dtype, np.floating):
            out[v] = out[v].astype("float32")

    # 3) bit-round the scalars in place (transparent to the browser reader)
    for v in FIELDS_4D:
        if v in out and keepbits.get(v):
            out[v] = xr.apply_ufunc(
                bitround, out[v], kwargs={"keepbits": keepbits[v]}, keep_attrs=True
            )

    # 4) chunk to match the viewer's access pattern
    out = out.chunk({"time": 1, "Z": chunk_z, "lat": -1, "lon": -1})

    ny, nx = out.sizes["lat"], out.sizes["lon"]
    comp = numcodecs.Blosc(cname="zstd", clevel=clevel, shuffle=numcodecs.Blosc.SHUFFLE)
    enc = {}
    for v in FIELDS_4D:
        if v in out:
            enc[v] = {"chunks": (1, chunk_z, ny, nx), "compressor": comp, "dtype": "float32"}
    for v in FIELDS_3D:
        if v in out:
            enc[v] = {"chunks": (1, ny, nx), "compressor": comp, "dtype": "float32"}

    out.to_zarr(path, mode="w", consolidated=True, encoding=enc, zarr_version=2)
    return out


# ---------------------------------------------------------------------------
# OPT-IN: int16 CF packing. Smallest option, but the browser loader must apply
# scale_factor / add_offset / _FillValue after reading (zarrita does NOT do CF
# decoding automatically). Ask before using -- it needs a small gsZarr.ts change.
# ---------------------------------------------------------------------------
def int16_encoding(da, fill=-32768):
    """Return an xarray encoding dict that packs `da` into int16 (CF style)."""
    vmin = float(da.min(skipna=True))
    vmax = float(da.max(skipna=True))
    scale = (vmax - vmin) / 65534.0          # 2*32767 usable levels
    add_offset = vmin + 32767.0 * scale      # so packed values land in [-32767, 32767]
    return {
        "dtype": "int16",
        "scale_factor": scale,
        "add_offset": add_offset,
        "_FillValue": fill,
    }


if __name__ == "__main__":
    # Usage inside the notebook (after `nordic_regrid` is built):
    #
    #   from save_nordic_web_zarr import save_nordic_web_zarr
    #   save_nordic_web_zarr(
    #       nordic_regrid, "nordic.zarr",
    #       keepbits={"T": 12, "S": 14, "rho": 14,
    #                 "U_cgrid": 10, "V_cgrid": 10}, clevel=5,
    #   )
    print(__doc__)
