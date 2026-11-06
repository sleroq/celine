import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { flush } from "solid-js";
import { accountApi } from "../src/api";
import { createEmojiPacks } from "../src/emoji-packs";

const recent = { id: "100", label: "⭐", source: "Recent", thumbnail_url: "/recent.png" };
const leaf = { id: "200", label: "🌿", source: "Nature", thumbnail_url: "/leaf.png" };
const fire = { id: "300", label: "🔥", source: "Reactions", thumbnail_url: "/fire.png" };
const catalog = {
    choices: [recent],
    sets: [
        {
            id: "2000",
            title: "Nature",
            cover_url: "/api/accounts/account-a/emojis/sets/2000/cover",
            count: 3,
        },
        {
            id: "3000",
            title: "Reactions",
            cover_url: "/api/accounts/account-a/emojis/sets/3000/cover",
            count: 2,
        },
    ],
    premium: true,
};

afterEach(() => mock.restore());

describe("emoji pack browsing", () => {
    test("keeps account catalogs and cached choices separate", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json(catalog))
            .mockResolvedValueOnce(Response.json({ choices: [], sets: [], premium: false }));
        const personal = createEmojiPacks(accountApi("personal"));
        const work = createEmojiPacks(accountApi("work"));
        await personal.select();
        expect(work.active).toBeUndefined();
        await work.select();
        expect(work.sets).toEqual([]);
        expect(work.find(recent.id)).toBeUndefined();
        expect(personal.find(recent.id)).toEqual(recent);
        await personal.select();
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
            "/api/accounts/personal/emojis",
            "/api/accounts/work/emojis",
        ]);
    });

    test("loads recent/default and pack titles once", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(catalog));
        const packs = createEmojiPacks(accountApi("account-a"));
        expect(packs.active).toBeUndefined();
        await packs.select();
        expect(packs.activeId).toBe("");
        expect(packs.title).toBe("Recent / default");
        expect(packs.sets).toEqual(catalog.sets);
        expect(packs.active).toEqual({ choices: [recent], loading: false, error: "" });
        await packs.select("");
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe("/api/accounts/account-a/emojis");
    });

    test("switches to only the active pack and retains choices from other packs", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json(catalog))
            .mockResolvedValueOnce(Response.json({ choices: [leaf] }))
            .mockResolvedValueOnce(Response.json({ choices: [fire] }));
        const packs = createEmojiPacks(accountApi("account-a"));
        await packs.select();
        await packs.select("2000");
        expect(packs.title).toBe("Nature");
        expect(packs.count).toBe(3);
        expect(packs.active?.choices).toEqual([leaf]);
        const nature = packs.active?.choices;
        await packs.select("3000");
        expect(packs.title).toBe("Reactions");
        expect(packs.count).toBe(2);
        expect(packs.active?.choices).toEqual([fire]);
        expect(packs.find(leaf.id)).toEqual(leaf);
        expect(packs.find(recent.id)).toEqual(recent);
        expect(packs.find("missing")).toBeUndefined();
        void packs.select("2000");
        flush();
        expect(packs.active?.choices).toBe(nature);
        expect(packs.active?.loading).toBe(false);
        await packs.select("");
        expect(packs.active?.choices).toEqual([recent]);
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
            "/api/accounts/account-a/emojis",
            "/api/accounts/account-a/emojis/sets/2000",
            "/api/accounts/account-a/emojis/sets/3000",
        ]);
    });

    test("caches an empty pack instead of refetching it", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [] }));
        const packs = createEmojiPacks(accountApi("account-a"));
        await packs.select("4000");
        await packs.select("4000");
        expect(packs.active?.choices).toEqual([]);
        expect(packs.active?.loading).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test("does not duplicate in-flight loads or replace a newer active pack", async () => {
        let respond!: (response: Response) => void;
        const slow = new Promise<Response>((resolve) => {
            respond = resolve;
        });
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json(catalog))
            .mockReturnValueOnce(slow)
            .mockResolvedValueOnce(Response.json({ choices: [fire] }));
        const packs = createEmojiPacks(accountApi("account-a"));
        await packs.select();
        const loading = packs.select("2000");
        flush();
        expect(packs.active).toEqual({ loading: true, error: "" });
        await packs.select("2000");
        expect(fetch).toHaveBeenCalledTimes(2);
        await packs.select("3000");
        respond(Response.json({ choices: [leaf] }));
        await loading;
        expect(packs.activeId).toBe("3000");
        expect(packs.title).toBe("Reactions");
        expect(packs.active).toEqual({ choices: [fire], loading: false, error: "" });
        await packs.select("2000");
        expect(packs.active?.choices).toEqual([leaf]);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    test("keeps catalog errors local and retries discovery", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                Response.json({ error: "Telegram unavailable." }, { status: 503 }),
            )
            .mockResolvedValueOnce(Response.json(catalog));
        const packs = createEmojiPacks(accountApi("account-a"));
        await packs.select();
        expect(packs.active).toEqual({ loading: false, error: "Telegram unavailable." });
        expect(packs.sets).toEqual([]);
        await packs.select();
        expect(packs.active).toEqual({ choices: [recent], loading: false, error: "" });
        expect(packs.sets).toEqual(catalog.sets);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test("does not show a failed pack's error in recent/default and allows retrying", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json(catalog))
            .mockRejectedValueOnce(new Error("Pack unavailable."))
            .mockResolvedValueOnce(Response.json({ choices: [leaf] }));
        const packs = createEmojiPacks(accountApi("account-a"));
        await packs.select();
        await packs.select("2000");
        expect(packs.title).toBe("Nature");
        expect(packs.active).toEqual({ loading: false, error: "Cannot reach Celine." });
        await packs.select("");
        expect(packs.active).toEqual({ choices: [recent], loading: false, error: "" });
        await packs.select("2000");
        expect(packs.active).toEqual({ choices: [leaf], loading: false, error: "" });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    test("preserves document-sized pack IDs", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [] }));
        const packs = createEmojiPacks(accountApi("account-a"));
        await packs.select("9223372036854775806");
        expect(packs.activeId).toBe("9223372036854775806");
        expect(fetch.mock.calls[0][0]).toBe(
            "/api/accounts/account-a/emojis/sets/9223372036854775806",
        );
    });
});
