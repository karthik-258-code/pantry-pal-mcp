import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Bundles mcp-app.html + src into one self-contained HTML file (dist/mcp-app.html),
// which the MCP server returns as the ui://pantry-pal/app.html resource.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: "mcp-app.html" },
  },
});
