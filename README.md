# Nordic Seas Explorer

Interactive Nordic Seas visualization (Plotly + React + Vite) for:

- 3D bathymetry background
- Horizontal `T` / `S` slices (lon–lat at selected depth)
- Vertical transects (lon–depth at selected latitude)
- Class mode (e.g. temperature/salinity classes in 3D)
- Time animation (movie mode)
- Optional overlay: sea ice concentration


## Data layout

### Zarr dataset (primary data source)

Place a Zarr store in one of:

- `public/data/nordic.zarr/` (default)
- `public/data/nordicseas.zarr/`
- `public/data/greenlandsea.zarr/` (legacy fallback)
- `public/data/GS_web.zarr/`

The app reads variables:

- Required: `T`, `S`
- Optional: `SIarea`

Coordinate arrays are read from the store when available (`lon`, `lat`, `time`, `Z`).

### Bathymetry (3D background)

Supported files (see `public/data/README.md`):

- `public/data/nordic.json` (default)
- `public/data/greenlandsea.json` (legacy fallback)
- `public/data/bathy.json` (fallback)
- `public/data/bathy_RTopo_ds.json` (recommended if available)
- `public/data/bathy_RTopo.json` (high resolution but large)

See `public/data/README.md` for format details.

## UI summary

### View modes

- **Horizontal**: choose time + depth, render a lon–lat slice over 3D bathymetry
- **Transect**: choose time + latitude, render a lon–depth curtain
- **Class**: render discrete `T`/`S` classes in 3D space

### Controls

- Variable (`T` / `S`)
- Time slider + movie toggle/FPS
- Color scale min/max, ticks, colormap, discrete/continuous mode
- Bathymetry/contour toggles
- Sea ice overlay toggle
- Depth scaling / vertical exaggeration controls
- Camera reset and day/night theme toggle
- Feedback links (webpage, GitHub, LinkedIn, email)

## Hosting / GitHub Pages

This app is static-site friendly (Zarr chunks are fetched directly by the browser).

- Repo: `nordicseas2` (local transfer)
- You can override dataset URL with:
  - query param: `?store=https://.../nordic.zarr`
  - env var: `VITE_GS_ZARR_URL`

## References

D. Jian, X. Zhai, D. P. Stevens, I. Renfrew (2026)  
**Oceanic Heat Transport Along the Norwegian Atlantic Slope Current and the Role of Eddies**  
*Journal of Geophysical Research: Oceans*  
https://doi.org/10.1029/2025JC022960

D. Jian, X. Zhai, D. P. Stevens, I. Renfrew (2026)  
**Long-lived anticyclonic eddies promote progressive convection in the Greenland Sea**  
*Submitted to Geophysical Research Letters*  (Brutally rejected)

## Links

- Nordic Seas Flow Visualization: https://nordicseas.github.io/
- Personal webpage: https://bve23zsu.github.io/
