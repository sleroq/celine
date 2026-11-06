import { expect, test } from "bun:test";
import { reconcilePhotoOrder } from "../src/api";

test("photo order retains new photos and drops removed photos", () => {
    const draft = ["c", "b", "a"];
    const server = ["a", "c", "new"];
    expect(reconcilePhotoOrder(draft, server)).toEqual(["c", "a", "new"]);
    expect(draft).toEqual(["c", "b", "a"]);
    expect(server).toEqual(["a", "c", "new"]);
});
