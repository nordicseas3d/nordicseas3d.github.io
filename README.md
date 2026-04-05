# Nordic Seas

Interactive browser viewer for Nordic Seas ocean fields. The app reads a Zarr store directly in the browser and renders the domain on a 3D bathymetry surface with a left-side control panel for view, slicing, overlays, masks, and styling.

## What the app supports

- Horizontal maps at a selected depth and time
- Zonal sections at a selected latitude target
- Drawn transects between two user-picked map points
- 3D class view for value bands through the water column
- Eddy view for detected eddy structures
- Optional topography, wind stress, and sea-ice overlays
- Basin masking for the North Atlantic, Greenland Sea, Iceland Sea, and Norwegian Sea
- Adjustable color scales, contours, opacity, and vertical exaggeration
- Fullscreen viewing 

## Main interactions

- `Horizontal`: browse a constant-depth map slice.
- `Zonal`: slice the latitude target to move the west-east section north or south.
- `Draw`: adjust the view angle first, click `Draw line`, then click two map points. Click `Clear` to remove the line, adjust the angle again if needed, and start a new draw.
- `Class`: inspect point-cloud classes inside a configurable min/max value range.


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
- Plotly rendering is heavier in `Zonal`, `Draw`, and `Class` modes than in the default horizontal map view.

## Links

- Nordic Seas Ocean Circulation: https://nordicseas.github.io/
