import { describe, expect, test } from "bun:test";
import { photoMatchMessage } from "../src/photo-status";

const unlinked = { id: "local", telegram_id: null, history_checked: true };
const linked = { id: "selected", telegram_id: "42", history_checked: true };
const photos = [{ id: "42" }];
const recovery = {};

describe("photo match status", () => {
    test("distinguishes cached reuse from a missing Telegram photo", () => {
        expect(photoMatchMessage(linked, { status: "ready", photos, recovery })).toBe(
            "photoReusable",
        );
        expect(photoMatchMessage(linked, { status: "ready", photos: [], recovery })).toBe(
            "photoUnavailable",
        );
    });

    test("never calls a photo new before a complete successful refresh", () => {
        expect(photoMatchMessage(unlinked, { status: "ready", photos, recovery })).toBe(
            "photoUploadNew",
        );
        expect(photoMatchMessage(unlinked, { status: "refreshing", photos, recovery })).toBe(
            "photoChecking",
        );
        expect(photoMatchMessage(unlinked, { status: "error", photos, recovery })).toBe(
            "photoUnknown",
        );
        expect(
            photoMatchMessage(
                { ...unlinked, history_checked: false },
                { status: "ready", photos, recovery },
            ),
        ).toBe("photoUnknown");
    });

    test("can show a cached match during an incomplete refresh", () => {
        expect(photoMatchMessage(linked, { status: "refreshing", photos, recovery })).toBe(
            "photoReusable",
        );
        expect(photoMatchMessage(linked, { status: "refreshing", photos: [], recovery })).toBe(
            "photoChecking",
        );
    });

    test("distinguishes a duplicate from an unavailable Telegram photo", () => {
        const duplicate = { selected: { duplicate_of: "other", can_upload: true } };
        expect(
            photoMatchMessage(linked, { status: "ready", photos: [], recovery: duplicate }),
        ).toBe("photoDuplicate");
        expect(
            photoMatchMessage(linked, { status: "refreshing", photos: [], recovery: duplicate }),
        ).toBe("photoChecking");
        expect(
            photoMatchMessage(linked, { status: "error", photos: [], recovery: duplicate }),
        ).toBe("photoUnknown");
        expect(photoMatchMessage(linked, { status: "ready", photos, recovery: duplicate })).toBe(
            "photoReusable",
        );
        expect(
            photoMatchMessage(linked, {
                status: "ready",
                photos: [],
                recovery: { selected: { duplicate_of: null, can_upload: true } },
            }),
        ).toBe("photoUnavailable");
    });
});
