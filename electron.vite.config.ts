import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const shared = resolve("src/shared");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    resolve: { alias: { "@shared": shared } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    resolve: { alias: { "@shared": shared } },
  },
  renderer: {
    resolve: { alias: { "@shared": shared } },
    plugins: [react()],
  },
});
