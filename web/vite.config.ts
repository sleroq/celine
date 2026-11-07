import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const apiTarget = "http://127.0.0.1:7766";

export default defineConfig({
    optimizeDeps: { exclude: ["tlottie"] },
    plugins: [tailwindcss(), solid()],
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
});
