import { describe, expect, test } from "bun:test";
import { createRoot, flush } from "solid-js";
import { createNotifications } from "../src/notification-center";

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("notifications", () => {
    test("stacks messages and expires each on its own timer", async () => {
        let dispose!: () => void;
        const center = createRoot((end) => {
            dispose = end;
            return createNotifications(80);
        });
        center.push("First");
        await wait(45);
        center.push("Second");
        flush();
        expect(center.items().map((item) => item.message)).toEqual(["First", "Second"]);
        await wait(50);
        flush();
        expect(center.items().map((item) => item.message)).toEqual(["Second"]);
        await wait(45);
        flush();
        expect(center.items()).toEqual([]);
        dispose();
    });

    test("dismisses independently and clears timers on disposal", async () => {
        let dispose!: () => void;
        const center = createRoot((end) => {
            dispose = end;
            return createNotifications(30);
        });
        let retries = 0;
        const first = center.push("Failed", () => {
            retries++;
        });
        center.push("Another");
        flush();
        center.items()[0].action?.();
        center.dismiss(first);
        flush();
        expect(retries).toBe(1);
        expect(center.items().map((item) => item.message)).toEqual(["Another"]);
        dispose();
        await wait(45);
        flush();
        expect(center.items().map((item) => item.message)).toEqual(["Another"]);
    });
});
