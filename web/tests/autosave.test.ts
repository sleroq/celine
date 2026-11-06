import { describe, expect, test } from "bun:test";
import { createAutosave } from "../src/autosave";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("autosave", () => {
    test("serializes writes and coalesces edits made while saving", async () => {
        const first = deferred();
        const writes: number[] = [];
        let refreshes = 0;
        const save = createAutosave<number>(
            async (value) => {
                writes.push(value);
                if (value === 1) await first.promise;
            },
            async () => {
                refreshes++;
            },
            60_000,
        );
        save.edit(1);
        const done = save.flush();
        save.edit(2);
        save.edit(3);
        expect(save.draft()).toBe(3);
        first.resolve();
        await done;
        expect(writes).toEqual([1, 3]);
        expect(refreshes).toBe(1);
        expect(save.status()).toBe("saved");
        save.dispose();
    });

    test("flushes pending valid edits on disposal", async () => {
        const writes: number[] = [];
        const save = createAutosave<number>(
            async (value) => {
                writes.push(value);
            },
            async () => {},
            60_000,
        );
        save.edit(4);
        save.dispose();
        await save.flush();
        expect(writes).toEqual([4]);
    });

    test("retains failed edits for retry", async () => {
        let attempts = 0;
        const save = createAutosave<string>(
            async () => {
                if (++attempts === 1) throw new Error("offline");
            },
            async () => {},
            60_000,
        );
        save.edit("latest");
        await expect(save.flush()).rejects.toThrow("offline");
        expect(save.status()).toBe("error");
        expect(save.draft()).toBe("latest");
        await save.retry();
        expect(save.status()).toBe("saved");
        expect(attempts).toBe(2);
        save.dispose();
    });

    test("retries a failed refresh without writing the saved value again", async () => {
        let writes = 0;
        let refreshes = 0;
        const save = createAutosave<number>(
            async () => {
                writes++;
            },
            async () => {
                if (++refreshes === 1) throw new Error("offline");
            },
            60_000,
        );
        save.edit(1);
        await expect(save.flush()).rejects.toThrow("offline");
        expect(save.draft()).toBe(1);
        expect(save.status()).toBe("error");
        await save.retry();
        expect(writes).toBe(1);
        expect(refreshes).toBe(2);
        expect(save.status()).toBe("saved");
        save.dispose();
    });

    test("does not write invalid edits even if they arrive during a write", async () => {
        const first = deferred();
        const writes: number[] = [];
        const save = createAutosave<number>(
            async (value) => {
                writes.push(value);
                await first.promise;
            },
            async () => {},
            60_000,
        );
        save.edit(1);
        const done = save.flush();
        save.edit(0, false);
        first.resolve();
        await expect(done).rejects.toThrow();
        expect(writes).toEqual([1]);
        save.edit(2);
        await save.flush();
        expect(writes).toEqual([1, 2]);
        save.dispose();
    });
});
