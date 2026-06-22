import { defineConfig } from "vitest/config";

// Activate with:  npm install -D vitest
// then run:  npm test
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
