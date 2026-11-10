import { expect, test } from "bun:test";

test("autosave reporting tracks validity, retries safely, and clears on disposal", () => {
    const result = Bun.spawnSync(
        [process.execPath, "--conditions=browser", "run", "fixtures/save-status-reactivity.ts"],
        { cwd: import.meta.dir },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
});
