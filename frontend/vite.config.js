import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Set VITE_BASE_PATH to /repo-name/ when deploying to GitHub Pages
  base: process.env.VITE_BASE_PATH || "/",
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
});
