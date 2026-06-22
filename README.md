# Nordic Seas

Interactive browser viewer for Nordic Seas ocean fields. The app reads a Zarr store directly in the browser and renders the domain on 3D bathymetry with a compact left-side control panel.

## Current capabilities

- Horizontal 3D map slices at a selected depth and time
- Zonal sections at a selected latitude
- User-drawn transects between two picked map points
- 3D class clouds for value bands through the water column
- Isosurface mode for isothermal, isohaline, and isopycnal depth sheets
- Eddy detection / eddy volume view
- Optional topography, wind-stress, and sea-ice layers
- Depth-resolved ocean-current vectors in both Plotly and Three renderers
- Optional sea-surface-height layer
- Basin masking for the North Atlantic, Greenland Sea, Iceland Sea, and Norwegian Sea
- First-visit guided tutorial with step-by-step highlighted controls
- Fullscreen panel workflow and mobile-safe panel sizing

## Main modes

- `Horizontal`: browse a constant-depth map slice. Users can switch the viewer between `Three` and `Plotly`. `Three` is smoother; `Plotly` is heavier.
- `Zonal`: slice a west-east section by moving the latitude target north or south.
- `Draw`: adjust the view angle first, click `Draw line`, then click two map points. Click `Clear` to remove the line and restart.
- `Class`: render point-cloud classes for a configurable min/max range, interval, half-width, and density.
- `Isosurface`: show the shallowest depth where the active variable reaches a target value. The surface is colored by depth, and hover still reports the selected field value.
- `Eddies`: inspect detected warm/cold anomaly structures and their tracks.

## Variables and overlays

- Scalar variables: `Temperature`, `Salinity`, `Potential density`
- Surface / 2D layers: `Sea ice`, `Wind stress`
- Bathymetry can be shown or hidden independently

`Temperature`, `Salinity`, and `Potential density` share one scalar layer, so enabling one switches the others off.

## Tutorial

On a first visit, the app opens a tutorial prompt. If the user starts it, the tutorial walks through the major features in steps and highlights the relevant control area with a spotlight box and callout arrow.

Users can reopen the tutorial any time with the `?` button in the control-panel header.

## Local development

```bash
npm install
npm start
```

Other scripts:

- `npm run build`: production build into `dist/`
- `npm run preview`: preview the built app locally

## Stack

- React 18
- TypeScript
- Vite
- Plotly
- Three.js
- `zarrita` for client-side Zarr access

## Data layout

### Zarr store

The app looks for a readable Zarr store in this order:

1. `?store=...` URL parameter
2. `VITE_GS_ZARR_URL`
3. `public/data/nordic.zarr/`

The current bundled sample store is `public/data/nordic.zarr/`.

Supported scalar variables:

- `T`
- `S`
- `rho`

Supported 2D auxiliary fields:

- `SIarea`
- `uwind_stress`
- `vwind_stress`
- `Eta_noice`

Supported velocity fields:

- `U_cgrid`
- `V_cgrid`

Expected coordinates:

- `lon`
- `lat`
- `Z`
- `time`

If `Z` is missing, the loader falls back to `drF` to derive depth centers. If `lon` / `lat` cannot be read from the Zarr store, the app falls back to bathymetry JSON coordinates.

The bundled local fields are coarsened from the original data to a `312 x 320` horizontal grid.

The bundled dataset currently exposes:

- `T`: `[73, 72, 312, 320]`
- `S`: `[73, 72, 312, 320]`
- `rho`: `[73, 72, 312, 320]`
- `U_cgrid`: `[73, 72, 312, 320]`
- `V_cgrid`: `[73, 72, 312, 320]`
- `SIarea`: `[73, 312, 320]`
- `uwind_stress`: `[73, 312, 320]`
- `vwind_stress`: `[73, 312, 320]`
- `Eta_noice`: `[73, 312, 320]`
- `lon`: `[312, 320]`
- `lat`: `[312, 320]`
- `Z`: `[72]`
- `time`: `[73]`

### Bathymetry

The 3D basemap is loaded from bathymetry JSON in `public/data/`. The current preferred model-grid topo file is:

- `public/data/nordic_model_grid_4.5-1km.json`

The loader also keeps fallback bathymetry JSON names for older datasets.

## Deployment

This project is static-site friendly. The included GitHub Actions workflow builds `dist/` and deploys it to GitHub Pages.

If the Zarr store is too large to ship with the site, point the build at a remote store with `VITE_GS_ZARR_URL`. Remote-data builds automatically omit `dist/data/nordic.zarr`; `?store=...` remains useful as a runtime override but cannot reduce the build artifact by itself.

## Notes

- `vite.config.ts` uses `base: "./"` so the built site works from GitHub Pages subpaths and local static hosting.
- Plotly rendering is heavier than `Three` in the default map workflow, and Plotly-heavy modes such as `Zonal`, `Draw`, `Class`, and Plotly `Isosurface` can update more slowly.
- `public/maps/README.md` documents an older image-drop workflow. The current primary app path is the Zarr-backed 3D viewer described here.

## Link

- Nordic Seas Ocean Circulation: https://nordicseas.github.io/
