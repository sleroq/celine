import { describe, expect, test } from "bun:test";
import { photoMatchMessage } from "../src/photo-status";

const unlinked = { telegram_id: null, history_checked: true };
const linked = { telegram_id: "42", history_checked: true };
const photos = [{ id: "42" }];

describe("photo match status", () => {
    test("distinguishes cached reuse from a missing Telegram photo", () => {
        expect(photoMatchMessage(linked, { status: "ready", photos })).toBe("photoReusable");
        expect(photoMatchMessage(linked, { status: "ready", photos: [] })).toBe("photoUnavailable");
    });

    test("never calls a photo new before a complete successful refresh", () => {
        expect(photoMatchMessage(unlinked, { status: "ready", photos })).toBe("photoUploadNew");
        expect(photoMatchMessage(unlinked, { status: "refreshing", photos })).toBe("photoChecking");
        expect(photoMatchMessage(unlinked, { status: "error", photos })).toBe("photoUnknown");
        expect(
            photoMatchMessage({ ...unlinked, history_checked: false }, { status: "ready", photos }),
        ).toBe("photoUnknown");
    });

    test("can show a cached match during an incomplete refresh", () => {
        expect(photoMatchMessage(linked, { status: "refreshing", photos })).toBe("photoReusable");
        expect(photoMatchMessage(linked, { status: "refreshing", photos: [] })).toBe(
            "photoChecking",
        );
    });
});
