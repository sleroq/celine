import { expect, test } from "bun:test";

test("poll snapshots suppress unchanged updates and preserve changes, deletions, drafts and account switches", () => {
    // Bun otherwise resolves Solid's non-reactive server runtime.
    const result = Bun.spawnSync(
        [process.execPath, "--conditions=browser", "run", "fixtures/app-state-reactivity.ts"],
        { cwd: import.meta.dir },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
});
