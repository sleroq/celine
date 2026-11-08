import { expect, test } from "bun:test";
import { createAppearanceDraft, updateAppearanceSection } from "../src/appearance-editor";
import { profileBackground, replyAccent, swatchFill } from "../src/appearance-preview";

test("palette swatches show distinct colors without blending", () => {
    expect(swatchFill([])).toBe("transparent");
    expect(swatchFill([0x123456])).toBe("#123456");
    expect(swatchFill([0x123456, 0xabcdef])).toBe(
        "linear-gradient(135deg, #123456 0% 50%, #abcdef 50% 100%)",
    );
    expect(swatchFill([0x123456, 0xabcdef, 0x000001])).toContain("#000001 66.66666666666666% 100%");
});

test("reply accent uses every palette color as stripes", () => {
    expect(replyAccent([])).toBeUndefined();
    expect(replyAccent([0x123456])).toBe("#123456");
    expect(replyAccent([0x123456, 0xabcdef])).toBe(
        "repeating-linear-gradient(135deg, #123456 0px 5px, #abcdef 5px 10px)",
    );
    expect(replyAccent([0x123456, 0xabcdef, 0x000001])).toBe(
        "repeating-linear-gradient(135deg, #123456 0px 5px, #abcdef 5px 10px, #000001 10px 15px)",
    );
});

test("section edits preserve external values and distinguish reset from unset", () => {
    const emoji = { id: "9223372036854775807", label: "Star", source: "Background" };
    const name = { color: 99, emoji };
    const original = { profile: null, name };
    const reset = updateAppearanceSection(original, "profile", { color: null, emoji: null });
    expect(reset.profile).toEqual({ color: null, emoji: null });
    expect(reset.name).toBe(name);
    expect(updateAppearanceSection(reset, "profile", null)).toEqual(original);
    expect(original.profile).toBeNull();
});

test("appearance initializes once when current data arrives without clobbering edits", () => {
    const draft = createAppearanceDraft();
    const current = { profile: { color: 2, emoji: null }, name: null };
    expect(draft.initialize(undefined)).toBeUndefined();
    const initial = draft.initialize(current);
    expect(initial).toEqual(current);
    expect(initial).not.toBe(current);
    expect(draft.initialize({ ...current, name: { color: 3, emoji: null } })).toBeUndefined();
    draft.edit();
    expect(draft.initialize(current)).toBeUndefined();
});

test("preset selection or editing before loading wins; account drafts are independent", () => {
    const first = createAppearanceDraft();
    const second = createAppearanceDraft();
    const current = { profile: null, name: { color: 4, emoji: null } };
    first.edit();
    expect(first.initialize(current)).toBeUndefined();
    expect(second.initialize(current)).toEqual(current);
});

test("profile backgrounds use the second color at the avatar and first at the edge", () => {
    expect(profileBackground([])).toBeUndefined();
    expect(profileBackground([0x123456])).toBe("#123456");
    expect(profileBackground([0x123456, 0xabcdef])).toBe(
        "radial-gradient(ellipse 140px 110px at 50% 72px, #abcdef, #123456)",
    );
});
