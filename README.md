# Nordic Seas

Interactive browser viewer for Nordic Seas temperature and salinity fields. The app loads a Zarr store directly in the browser and renders slices over a 3D bathymetry surface with Plotly.

## What the app supports

- Horizontal maps at a selected depth and time
- Zonal sections at a selected latitude
- Draw-your-own transects between two clicked map points
- 3D class view for value bands
- Time animation
- Optional sea-ice overlay
- Basin masking for the GSR, Greenland Sea, Iceland Sea, and Norwegian Sea
- Adjustable color scales, contours, opacity, and vertical exaggeration

## Stack

- React 18
- TypeScript
- Vite
- Plotly
- `zarrita` for client-side Zarr access


## Data layout

### Zarr store

The app looks for a readable Zarr store in this order:

- `public/data/nordic.zarr/`

Expected variables:

- Required: `T`, `S`
- Optional: `SIarea`

Coordinate handling:

- Uses `lon`, `lat`, `time`, and `Z` when available
- Falls back to `drF` to derive depth centers if `Z` is missing
- Falls back to bathymetry JSON for lon/lat if coordinate arrays cannot be read

The sample dataset bundled in this repo is `public/data/nordic.zarr/`. Its consolidated metadata shows:

- `T`: `[73, 72, 400, 400]`
- `S`: `[73, 72, 400, 400]`
- `SIarea`: `[73, 400, 400]`

### Bathymetry

The 3D basemap is loaded from the first available bathymetry JSON:

- `public/data/nordic.json`


## Deployment

This project is static-site friendly. The included GitHub Actions workflow builds `dist/` and deploys it to GitHub Pages.

If the Zarr store is too large for Pages, set the repository variable `GS_ZARR_URL` so the built site reads a remote store instead of bundling or serving the local default.

## Notes

- `vite.config.ts` uses `base: "./"` so the built site works from GitHub Pages subpaths and local file-style hosting.
- `public/maps/README.md` documents an older image-drop workflow. The current app path is the Zarr-backed 3D viewer described above.

## Links

- Nordic Seas Ocean Circulation: https://nordicseas.github.io/
