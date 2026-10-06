import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: { "@": resolve(__dirname, "src/renderer/src") },
    },
    plugins: [react()],
    build: {
      chunkSizeWarningLimit: 1500,
    },
  },
});
