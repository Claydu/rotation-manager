import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: "./",
  build: { outDir: "docs" },
  define: {
    // Stamped into the app header so the coach can tell at a glance
    // whether the phone has picked up the latest deploy.
    __BUILD_DATE__: JSON.stringify(new Date().toLocaleDateString("en-AU",
      { day: "numeric", month: "short", year: "numeric" })),
  },
});
