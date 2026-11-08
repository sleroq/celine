import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const apiTarget = "http://127.0.0.1:7766";

export default defineConfig(({ mode }) => ({
    base: mode === "preview" ? "./" : "/",
    optimizeDeps: { exclude: ["tlottie"] },
    plugins: [
        tailwindcss(),
        solid(),
        ...(mode === "preview"
            ? [
                  {
                      name: "preview-entry",
                      writeBundle(options) {
                          return cp(
                              fileURLToPath(new URL("./preview-data", import.meta.url)),
                              resolve(options.dir!, "preview-data"),
                              { recursive: true },
                          );
                      },
                      transformIndexHtml: {
                          order: "pre" as const,
                          handler(html: string) {
                              return html
                                  .replace("/src/index.tsx", "/src/preview.tsx")
                                  .replace('<script src="/favicon.js"></script>', "");
                          },
                      },
                  } satisfies Plugin,
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
