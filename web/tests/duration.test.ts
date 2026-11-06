import { describe, expect, test } from "bun:test";
import { Duration } from "../src/duration";

describe("duration units", () => {
    test("offers seconds, minutes, hours and days", () => {
        expect(Duration.units.map((unit) => unit.seconds)).toEqual([1, 60, 3600, 86400]);
    });

    test("converts each unit to backend seconds", () => {
        expect(Duration.seconds(5, 1)).toBe(5);
        expect(Duration.seconds(5, 60)).toBe(300);
        expect(Duration.seconds(2, 3600)).toBe(7200);
        expect(Duration.seconds(2, 86400)).toBe(172800);
    });

    test("supports fractional units at whole-second precision", () => {
        expect(Duration.seconds(1.5, 60)).toBe(90);
        expect(Duration.seconds(0.25, 3600)).toBe(900);
        expect(Duration.seconds(0.5, 86400)).toBe(43200);
        expect(Duration.seconds(1.1, 60)).toBe(66);
    });

    test("defaults jitter to 10% of delay, rounded to seconds and capped at five minutes", () => {
        for (const [delay, jitter] of [
            [1, 0],
            [4, 0],
            [5, 1],
            [10, 1],
            [15, 2],
            [600, 60],
            [2994, 299],
            [2995, 300],
            [3600, 300],
        ]) {
            expect(Duration.defaultJitter(delay)).toBe(jitter);
        }
    });

    test("chooses readable initial units without changing saved seconds", () => {
        for (const seconds of [0, 1, 90, 3600, 90000]) {
            const unit = Duration.unitFor(seconds);
            expect(Duration.seconds(seconds / unit, unit)).toBe(seconds);
        }
        expect(Duration.unitFor(0)).toBe(1);
        expect(Duration.unitFor(90)).toBe(60);
        expect(Duration.unitFor(3600)).toBe(3600);
        expect(Duration.unitFor(86400)).toBe(86400);
    });
});
