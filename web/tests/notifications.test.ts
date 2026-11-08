import { afterEach, describe, expect, jest, test } from "bun:test";
import { createRoot, flush } from "solid-js";
import { createNotifications } from "../src/notification-center";

describe("notifications", () => {
    afterEach(() => jest.useRealTimers());

    test("stacks messages and expires each on its own timer", () => {
        jest.useFakeTimers();
        let dispose!: () => void;
        const center = createRoot((end) => {
            dispose = end;
            return createNotifications(80);
        });
        center.push("First");
        jest.advanceTimersByTime(45);
        center.push("Second");
        flush();
        expect(center.items().map((item) => item.message)).toEqual(["First", "Second"]);
        jest.advanceTimersByTime(50);
        flush();
        expect(center.items().map((item) => item.message)).toEqual(["Second"]);
        jest.advanceTimersByTime(45);
        flush();
        expect(center.items()).toEqual([]);
        dispose();
    });

    test("dismisses independently and clears timers on disposal", () => {
        jest.useFakeTimers();
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
        jest.advanceTimersByTime(45);
        flush();
        expect(center.items().map((item) => item.message)).toEqual(["Another"]);
    });
});
