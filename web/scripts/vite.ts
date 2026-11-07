import process from "node:process";

// Solid's Windows ARM compiler needs WASI.initialize, which Bun does not provide.
const runtime = process.platform === "win32" && process.arch === "arm64" ? "node" : "bun";
const vite = Bun.spawn([runtime, "node_modules/vite/bin/vite.js", ...process.argv.slice(2)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
});

process.exit(await vite.exited);
