import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,        // bind to 0.0.0.0 so the dev server is reachable on the LAN
    port: 5173,
    strictPort: true,  // fail loudly if 5173 is already taken
    proxy: {
      "/api":  "http://localhost:8000",
      "/ws":   { target: "ws://localhost:8000", ws: true },
    },
  },
});
