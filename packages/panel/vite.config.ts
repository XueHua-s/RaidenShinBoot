import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ["source", "browser", "module", "import", "default"]
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules\/(react|react-dom|scheduler)\//
            },
            {
              name: "refine-vendor",
              test: /node_modules\/@refinedev\//
            },
            {
              name: "ui-vendor",
              test: /node_modules\/(lucide-react|hono|react-router-dom|@remix-run)\//
            }
          ]
        }
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PANEL_PORT ?? 5173)
  }
});
