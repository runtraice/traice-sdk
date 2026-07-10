import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@traice/protocol": resolve(__dirname, "../protocol/src/index.ts"),
    },
  },
});
