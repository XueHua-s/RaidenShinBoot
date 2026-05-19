import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ["source", "browser", "module", "import", "default"]
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PANEL_PORT ?? 5173)
  }
});

