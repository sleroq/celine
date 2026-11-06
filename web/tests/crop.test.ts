import { describe, expect, test } from "bun:test";
import { centeredCrop, cropFromPixels, cropToPixels } from "../src/crop";

describe("crop coordinates in oriented image dimensions", () => {
    test("centers the largest square on landscape, portrait and square images", () => {
        expect(centeredCrop({ width: 400, height: 200 })).toEqual({ x: 0.25, y: 0, size: 1 });
        expect(centeredCrop({ width: 200, height: 400 })).toEqual({ x: 0, y: 0.25, size: 1 });
        expect(centeredCrop({ width: 200, height: 200 })).toEqual({ x: 0, y: 0, size: 1 });
    });
    test("converts each axis separately and size against the shorter side", () => {
        const dimensions = { width: 400, height: 200 };
        const crop = { x: 0.25, y: 0.1, size: 0.5 };
        const pixels = { x: 100, y: 20, width: 100, height: 100 };
        expect(cropToPixels(crop, dimensions)).toEqual(pixels);
        expect(cropFromPixels(pixels, dimensions)).toEqual(crop);
        const portrait = { width: 200, height: 400 };
        expect(cropToPixels(crop, portrait)).toEqual({ x: 50, y: 40, width: 100, height: 100 });
        expect(cropFromPixels(cropToPixels(crop, portrait), portrait)).toEqual(crop);
    });
});
