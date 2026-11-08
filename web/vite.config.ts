import { readFileSync } from "node:fs";
import { parsePreviewSettings } from "./src/preview-runtime";
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const apiTarget = "http://127.0.0.1:7766";

export default defineConfig(({ mode }) => ({
    base: mode === "preview" ? "./" : "/",
    define:
        mode === "preview"
            ? {
                  __PREVIEW_SETTINGS__: JSON.stringify(
                      parsePreviewSettings(
                          readFileSync(new URL("./preview/settings.json", import.meta.url), "utf8"),
                      ),
                  ),
              }
            : {},
    optimizeDeps: { exclude: ["tlottie"] },
    plugins: [
        tailwindcss(),
        solid(),
        ...(mode === "preview"
            ? [
                  {
                      name: "preview-entry",
                      transformIndexHtml: {
                          order: "pre" as const,
                          handler(html: string) {
                              return html
                                  .replace("/src/index.tsx", "/src/preview.tsx")
                                  .replace('<script src="/favicon.js"></script>', "");
                          },
                      },
                  },
              ]
            : []),
    ],
    server: {
        proxy: {
            "/api": {
                target: apiTarget,
                changeOrigin: true,
                configure(proxy) {
                    proxy.on("proxyReq", (request) => {
                        request.setHeader("Origin", apiTarget);
                    });
                },
            },
        },
    },
}));
