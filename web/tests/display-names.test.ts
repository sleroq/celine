import { describe, expect, test } from "bun:test";
import { emojiDisplayName, photoDisplayName } from "../src/display-names";
import { translate, type Locale } from "../src/i18n";

describe("localized display names", () => {
    for (const language of ["en", "ru", "uk"] satisfies Locale[]) {
        test(`${language}: generated photo and custom emoji names`, () => {
            expect(
                photoDisplayName({ name: "Telegram photo 123", generated_name: true }, language),
            ).toBe(translate(language, "telegramPhotoName"));
            expect(emojiDisplayName("Custom emoji", language)).toBe(
                translate(language, "customEmoji"),
            );
            expect(photoDisplayName({ name: "holiday.jpg" }, language)).toBe("holiday.jpg");
            expect(
                photoDisplayName({ name: "Telegram photo 123", generated_name: false }, language),
            ).toBe("Telegram photo 123");
            expect(emojiDisplayName("🙂", language)).toBe("🙂");
            expect(emojiDisplayName("Custom emoji pack", language)).toBe("Custom emoji pack");
            if (language !== "en") {
                expect(emojiDisplayName("Custom emoji", language)).not.toBe("Custom emoji");
            }
        });
    }
});
