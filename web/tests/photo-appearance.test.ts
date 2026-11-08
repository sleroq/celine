import { expect, test } from "bun:test";

test("photo appearance follows refreshed data without losing pending or failed drafts", () => {
    // Bun otherwise resolves Solid's non-reactive server runtime.
    const result = Bun.spawnSync(
        [
            process.execPath,
            "--conditions=browser",
            "run",
            "fixtures/photo-appearance-reactivity.ts",
        ],
        { cwd: import.meta.dir },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
});
