// Ambient module shims for runtime libraries that ship without their own
// TypeScript declarations in this project. They make `tsc --noEmit` resolve the
// imports as `any` (matching how the code already uses them), rather than
// failing with "Could not find a declaration file" (TS7016).
//
// `three` and OrbitControls are declared member-by-member as `any` so that
// `THREE.Mesh` works in both value and type position. If you later install the
// official typings (`npm i -D @types/three @types/react-plotly.js`), delete the
// matching block(s) below and run `npx tsc --noEmit` to surface stricter types.

declare module "three" {
  export const AdditiveBlending: any;
  export const BoxGeometry: any;
  export const BufferAttribute: any;
  export const BufferGeometry: any;
  export const Color: any;
  export const DirectionalLight: any;
  export const DoubleSide: any;
  export const Float32BufferAttribute: any;
  export const Group: any;
  export const HemisphereLight: any;
  export const InstancedMesh: any;
  export const Line: any;
  export const LineBasicMaterial: any;
  export const Material: any;
  export const MathUtils: any;
  export const Matrix4: any;
  export const Mesh: any;
  export const MeshBasicMaterial: any;
  export const MeshStandardMaterial: any;
  export const Object3D: any;
  export const PerspectiveCamera: any;
  export const PlaneGeometry: any;
  export const Points: any;
  export const PointsMaterial: any;
  export const Quaternion: any;
  export const Raycaster: any;
  export const SRGBColorSpace: any;
  export const Scene: any;
  export const Vector2: any;
  export const Vector3: any;
  export const WebGLRenderer: any;

  export type BoxGeometry = any;
  export type BufferAttribute = any;
  export type BufferGeometry = any;
  export type Color = any;
  export type DirectionalLight = any;
  export type Float32BufferAttribute = any;
  export type Group = any;
  export type HemisphereLight = any;
  export type InstancedMesh = any;
  export type Line = any;
  export type LineBasicMaterial = any;
  export type Material = any;
  export type Matrix4 = any;
  export type Mesh = any;
  export type MeshBasicMaterial = any;
  export type MeshStandardMaterial = any;
  export type Object3D = any;
  export type PerspectiveCamera = any;
  export type PlaneGeometry = any;
  export type Points = any;
  export type PointsMaterial = any;
  export type Quaternion = any;
  export type Raycaster = any;
  export type Scene = any;
  export type Vector2 = any;
  export type Vector3 = any;
  export type WebGLRenderer = any;
}

declare module "three/examples/jsm/controls/OrbitControls.js" {
  export const OrbitControls: any;
  export type OrbitControls = any;
}

declare module "react-plotly.js/factory";
declare module "plotly.js-dist-min";
