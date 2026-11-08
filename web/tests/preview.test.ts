import { expect, test } from "bun:test";
import { createPreviewFetch, parsePreviewSettings, previewMediaUrl } from "../src/preview-runtime";

import snapshotJson from "../preview-data/snapshot.json";
import type { PreviewSnapshot } from "../src/preview-runtime";

// SAFETY: the generated JSON is checked by the recursive publication-boundary test below.
const snapshot = snapshotJson as PreviewSnapshot;

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
    const fetch = createPreviewFetch(snapshot, async () => {
        network++;
        return new Response("asset");
    });

    try {
        const initial = await (await fetch("/api/state")).json();
        expect(initial.auth.status).toBe("authorized");
        expect(initial.profile.name).toBe("sl");
        expect(initial.accounts).toHaveLength(2);
        const firstId = snapshot.accounts[0]!.state.active_account_id;
        const secondId = snapshot.accounts[1]!.state.active_account_id;

        const edited = { ...schedule, interval_secs: 7200 };
        expect(
            (
                await fetch(`/api/accounts/${firstId}/settings`, {
                    method: "PUT",
                    body: JSON.stringify(edited),
                })
            ).status,
        ).toBe(204);
        const state = await (await fetch("/api/state")).json();
        expect(state.settings.interval_secs).toBe(7200);
        expect(state.emoji_settings.interval_secs).toBe(initial.emoji_settings.interval_secs);

        expect((await fetch("/api/accounts", { method: "POST" })).ok).toBe(false);
        expect((await fetch("https://other.example/api/auth", { method: "POST" })).ok).toBe(false);
        expect((await fetch("/celine/api/unknown")).ok).toBe(false);
        expect(network).toBe(0);
        await fetch(`/api/accounts/${secondId}/active`, { method: "PUT" });
        const second = await (await fetch("/api/state")).json();
        expect(second.active_account_id).toBe(secondId);
        expect(second.settings.interval_secs).toBe(
            snapshot.accounts[1]!.state.settings.interval_secs,
        );
        expect(
            (await (await fetch(`/api/accounts/${firstId}/state`)).json()).settings.interval_secs,
        ).toBe(7200);
        await fetch("/celine/assets/test.js");
        expect(network).toBe(1);

        const fresh = createPreviewFetch(snapshot, async () => new Response());
        expect((await (await fresh("/api/state")).json()).settings.interval_secs).toBe(
            snapshot.accounts[0]!.state.settings.interval_secs,
        );
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

test("snapshot publishes only UI state and local media with subpath-safe URLs", () => {
    const forbidden = /token|password|phone|qr_svg|session|telegram_not_before|pending_photo/;
    function inspect(value: unknown): void {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            expect(key).not.toMatch(forbidden);
            if (typeof child === "string") expect(child).not.toMatch(/https?:\/\/|\/api\//);
            else inspect(child);
        }
    }
    inspect(snapshot);
    for (const account of snapshot.accounts) {
        expect(account.state.active_account_id).toMatch(/^preview-\d+$/);
        for (const [path, asset] of Object.entries(account.media)) {
            expect(path).not.toContain("/original");
            expect(asset).toMatch(
                /^preview-data\/preview-\d+-[a-f0-9]+\.(jpg|png|webp|gif|tgs|webm)$/,
            );
            expect(
                previewMediaUrl(
                    snapshot,
                    account.state.active_account_id,
                    path,
                    "https://example.com/celine/",
                ),
            ).toBe(`https://example.com/celine/${asset}`);
        }
    }
});

test("exporter discards secrets at every API object boundary and never follows API URLs", async () => {
    const { exportPreview } = await import("../scripts/export-preview");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");

    const directory = await mkdtemp(`${tmpdir()}/celine-preview-`);
    const originalFetch = globalThis.fetch;
    const raw = structuredClone(snapshot.accounts[1]!.state);
    function poison<T extends object>(value: T) {
        return Object.assign(value, {
            session_token: "DO-NOT-PUBLISH",
            phone_number: "DO-NOT-PUBLISH",
        });
    }
    poison(raw);
    poison(raw.auth);
    poison(raw.profile!);
    poison(raw.settings);
    raw.profile!.photo_url = "https://untrusted.example/private";
    raw.photos.forEach(poison);
    raw.selected_emojis.forEach(poison);
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
        const url = String(input);
        expect(url.startsWith("http://127.0.0.1:7766/api/")).toBe(true);
        expect(url).not.toContain("/original");
        if (url.endsWith("/state"))
            return Response.json({ ...raw, accounts: [{ id: "private-account-id" }] });
        if (url.endsWith("/appearance/catalog"))
            return Response.json({ ...snapshot.accounts[1]!.catalog, token: "DO-NOT-PUBLISH" });
        return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
        });
    }, originalFetch);
    try {
        await exportPreview(undefined, new URL(`file://${directory}/`));
        const output = await readFile(`${directory}/snapshot.json`, "utf8");
        expect(output).not.toContain("DO-NOT-PUBLISH");
        expect(output).not.toContain("private-account-id");
        expect(output).not.toContain("untrusted.example");
    } finally {
        globalThis.fetch = originalFetch;
        await rm(directory, { recursive: true, force: true });
    }
});

test("account API uses static media directly in preview and restores live URLs afterwards", async () => {
    const { accountApi } = await import("../src/api");
    const previous = globalThis.__previewMedia;
    globalThis.__previewMedia = (account, path) =>
        previewMediaUrl(snapshot, account, path, "https://example.com/celine/");
    try {
        const account = snapshot.accounts[0]!;
        const photo = account.state.photos[0]!;
        const api = accountApi(account.state.active_account_id);
        expect(api.photoUrl(photo.id)).toBe(
            `https://example.com/celine/${account.media[`photos/${photo.id}`]}`,
        );
        expect(api.originalPhotoUrl(photo.id)).toBe(
            `https://example.com/celine/${account.media[`photos/${photo.id}`]}`,
        );
        expect(api.selectedPhotoUrl(photo)).toStartWith("https://example.com/celine/preview-data/");
        expect(api.emojiMediaUrl("not-exported")).toBe("");
    } finally {
        globalThis.__previewMedia = previous;
    }
    expect(accountApi("real").photoUrl("p")).toBe("/api/accounts/real/photos/p");
});
