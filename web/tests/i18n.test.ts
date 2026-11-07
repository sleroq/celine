import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messages, resolveLocale, translate, translateServerMessage } from "../src/i18n";
import { serverMessages } from "../src/server-messages";

describe("browser language selection", () => {
    test("uses the first supported language, including regional variants", () => {
        expect(resolveLocale(["de-DE", "uk-UA", "ru-RU", "en-US"])).toBe("uk");
        expect(resolveLocale(["de", "ru-KZ", "uk-UA"])).toBe("ru");
        expect(resolveLocale(["en-GB", "ru"])).toBe("en");
        expect(resolveLocale(["UK-ua"])).toBe("uk");
    });

    test("falls back to English without guessing from a country", () => {
        expect(resolveLocale(["kk-KZ", "fr-FR"])).toBe("en");
        expect(resolveLocale(["ua"])).toBe("en");
        expect(resolveLocale([])).toBe("en");
    });
});

function placeholders(catalog: Record<string, string>) {
    return Object.fromEntries(
        Object.entries(catalog).map(([key, message]) => [
            key,
            [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(),
        ]),
    );
}

describe("translation catalogs", () => {
    test("have the same messages and interpolation parameters", () => {
        for (const language of ["ru", "uk"] as const) {
            expect(placeholders(messages[language])).toEqual(placeholders(messages.en));
            expect(Object.values(messages[language]).every((message) => message.trim())).toBe(true);
        }
    });

    test("interpolates values without treating user content as markup or a replacement pattern", () => {
        expect(translate("en", "includeTelegramPhoto", { number: 12 })).toBe(
            "Include Telegram photo 12 in rotation",
        );
        expect(translate("ru", "nextPhoto", { time: "2 мин" })).toContain("2 мин");
        expect(translate("uk", "durationUnit", { label: "<b>$&</b>" })).toContain("<b>$&</b>");
    });

    test("keep server messages and their parameters aligned across languages", () => {
        for (const language of ["ru", "uk"] as const) {
            expect(placeholders(serverMessages[language])).toEqual(placeholders(serverMessages.en));
            expect(Object.values(serverMessages[language]).every((message) => message.trim())).toBe(
                true,
            );
        }
    });

    test("cover message codes declared by the backend", () => {
        const source = new URL("../../src/", import.meta.url);
        const files = new Bun.Glob("**/*.rs").scanSync({ cwd: fileURLToPath(source) });
        const codes = new Set<string>();
        for (const file of files) {
            const content = readFileSync(new URL(file, source), "utf8");
            for (const match of content.matchAll(
                /\b(?:Message|MessageInfo)::new\(\s*"([a-z_]+\.[a-z_]+)"/g,
            )) {
                codes.add(match[1]);
            }
        }
        expect(codes.size).toBeGreaterThan(0);
        expect([...codes].filter((code) => !Object.hasOwn(serverMessages.en, code))).toEqual([]);
    });

    test("translate server messages, opaque hints, cooldowns, and rotation context", () => {
        expect(
            translateServerMessage("uk", {
                code: "auth.password_hint",
                params: { hint: "<b>$&</b>" },
            }),
        ).toBe("Підказка до пароля: <b>$&</b>");
        expect(
            translateServerMessage("ru", {
                code: "telegram.cooldown",
                params: { seconds: 42, context: "photo" },
            }),
        ).toBe("Смена фото: Telegram запросил паузу. Повторите через 42 с.");
        expect(
            translateServerMessage("uk", { code: "telegram.password_incorrect", params: {} }),
        ).toBe("Неправильний пароль двоетапної перевірки Telegram.");
        expect(translateServerMessage("en", { code: "future.unknown", params: {} })).toBe(
            serverMessages.en["error.unclassified"],
        );
        expect(translateServerMessage("uk", null, "Old English server error")).toBe(
            messages.uk.requestFailed,
        );
        expect(translateServerMessage("en", null, "Old English server error")).toBe(
            "Old English server error",
        );
    });
});
