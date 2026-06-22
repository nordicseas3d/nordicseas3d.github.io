import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const remoteStoreUrl = env.VITE_GS_ZARR_URL?.trim();
  const publicDir = resolve(process.cwd(), "public");
  const bundledStoreDir = resolve(publicDir, "data/nordic.zarr");
  const outputDir = resolve(process.cwd(), "dist");

  return {
    // Relative base so the build works from file:// and GitHub Pages subpaths.
    base: "./",
    // For remote-data builds, copy the usable public assets ourselves without
    // first copying (and then deleting) the multi-gigabyte local Zarr store.
    publicDir: remoteStoreUrl ? false : "public",
    plugins: remoteStoreUrl
      ? [
          {
            name: "copy-public-without-bundled-zarr",
            closeBundle() {
              cpSync(publicDir, outputDir, {
                recursive: true,
                filter(source) {
                  return source !== bundledStoreDir && !source.startsWith(`${bundledStoreDir}/`);
                },
              });
            },
          },
        ]
      : [],
  };
});
