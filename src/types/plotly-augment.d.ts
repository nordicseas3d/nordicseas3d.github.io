// Augment Plotly's PlotData with 3D-surface trace properties that exist at
// runtime but are missing from the bundled @types/plotly.js. Keeping them
// optional + `any` matches how the traces are constructed in the viewer.
import "plotly.js";

declare module "plotly.js" {
  interface PlotData {
    surfacecolor?: any;
    lighting?: any;
    lightposition?: any;
    flatshading?: any;
    hidesurface?: any;
    cmin?: any;
    cmax?: any;
    cauto?: any;
    contours?: any;
  }
}
