import { describe, expect, test } from "bun:test";
import { emojiRenderer } from "../src/emoji-renderer";

describe("emoji renderer compatibility", () => {
    test.each(["a", "s", "i", "f", undefined, null, 1])(
        "uses SVG for active root mask mode %s",
        (mode) => {
            expect(emojiRenderer({ layers: [{ masksProperties: [{ mode }] }] })).toBe("svg");
        },
    );

    test("uses SVG for masks in a precomposition", () => {
        expect(
            emojiRenderer({
                layers: [{ ty: 0, refId: "precomp" }],
                assets: [{ id: "precomp", layers: [{ masksProperties: [{ mode: "s" }] }] }],
            }),
        ).toBe("svg");
    });

    test("uses SVG for masks in a nested precomposition asset", () => {
        expect(
            emojiRenderer({
                layers: [{ ty: 0, refId: "outer" }],
                assets: [
                    { id: "outer", layers: [{ ty: 0, refId: "inner" }] },
                    { id: "inner", layers: [{ masksProperties: [{ mode: "i" }] }] },
                ],
            }),
        ).toBe("svg");
    });

    test.each([
        {},
        { layers: [] },
        { layers: [{ ty: 4, nm: "ordinary layer" }], assets: [{ id: "image", p: "image.png" }] },
        { layers: [{ masksProperties: [] }] },
        { layers: [{ masksProperties: [{ mode: "n" }] }] },
        { assets: [{ layers: [{ masksProperties: [{ mode: "n" }] }] }] },
    ])("uses canvas for ordinary data or inactive masks: %j", (animation) => {
        expect(emojiRenderer(animation)).toBe("canvas");
        expect(emojiRenderer(animation, false)).toBe("canvas");
    });

    test("an inactive mask does not hide a later active mask", () => {
        expect(
            emojiRenderer({ layers: [{ masksProperties: [{ mode: "n" }, { mode: "a" }] }] }),
        ).toBe("svg");
    });

    test("keeps text-color emoji on SVG with or without masks", () => {
        expect(emojiRenderer({ layers: [] }, true)).toBe("svg");
        expect(emojiRenderer({ layers: [{ masksProperties: [{ mode: "s" }] }] }, true)).toBe("svg");
    });
});
