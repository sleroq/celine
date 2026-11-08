import { expect, test } from "bun:test";
import { createPreviewFetch, parsePreviewSettings } from "../src/preview-runtime";

const schedule = { enabled: false, mode: "ordered", interval_secs: 3600, jitter_secs: null };
function settings() {
    return parsePreviewSettings(
        JSON.stringify({
            settings: schedule,
            emoji_settings: schedule,
            appearance_settings: schedule,
        }),
    );
}

test("preview isolates all API paths and settings mutations from the network", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { href: "https://example.com/celine/" },
    });

    let network = 0;
    const fetch = createPreviewFetch(settings(), async () => {
        network++;
        return new Response("asset");
    });

    try {
        const initial = await (await fetch("/api/state")).json();
        expect(initial.auth.status).toBe("authorized");
        expect(initial.profile.name).toBe("Demo account");
        expect(initial.profile.premium).toBe(true);

        const edited = { ...schedule, interval_secs: 7200 };
        expect(
            (
                await fetch("/api/accounts/preview/settings", {
                    method: "PUT",
                    body: JSON.stringify(edited),
                })
            ).status,
        ).toBe(204);
        const state = await (await fetch("/api/state")).json();
        expect(state.settings.interval_secs).toBe(7200);
        expect(state.emoji_settings.interval_secs).toBe(3600);

        expect((await fetch("/api/accounts", { method: "POST" })).ok).toBe(false);
        expect((await fetch("https://other.example/api/auth", { method: "POST" })).ok).toBe(false);
        expect((await fetch("/celine/api/unknown")).ok).toBe(false);
        expect(network).toBe(0);
        expect((await (await fetch("/api/accounts/preview/emojis")).json()).choices).toEqual([]);
        await fetch("/celine/assets/test.js");
        expect(network).toBe(1);

        const fresh = createPreviewFetch(settings(), async () => new Response());
        expect((await (await fresh("/api/state")).json()).settings.interval_secs).toBe(3600);
    } finally {
        if (previous) Object.defineProperty(globalThis, "location", previous);
        else Reflect.deleteProperty(globalThis, "location");
    }
});

test("preview accepts only valid schedules and copies only Settings fields", () => {
    const value = settings();
    expect(() => parsePreviewSettings("{}")).toThrow();
    expect(() =>
        parsePreviewSettings(
            JSON.stringify({ ...value, settings: { ...schedule, interval_secs: -1 } }),
        ),
    ).toThrow();
    expect(
        parsePreviewSettings(JSON.stringify({ ...value, profile: { name: "ignored" } })),
    ).toEqual(value);
});
