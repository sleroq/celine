import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { flush } from "solid-js";
import { accountApi } from "../src/api";
import { createEmojiSearch } from "../src/emoji-search";

const fire = { id: "101", label: "🔥", source: "Search", source_kind: "search" as const };
const heart = { id: "102", label: "❤️", source: "Search", source_kind: "search" as const };

async function settle() {
    await Bun.sleep(10);
    flush();
}

async function debounce() {
    await Bun.sleep(350);
    flush();
}

afterEach(() => mock.restore());

describe("emoji search", () => {
    test("debounces, encodes queries, paginates, and retains discovered choices", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ choices: [fire], next_offset: 100 }))
            .mockResolvedValueOnce(Response.json({ choices: [fire, heart], next_offset: null }));
        const search = createEmojiSearch(accountApi("account-a"));
        search.setQuery("fi");
        search.setQuery(" 🔥 & fire ");
        expect(search.state.loading).toBe(true);
        await debounce();
        expect(fetch).toHaveBeenCalledTimes(1);
        const first = new URL(String(fetch.mock.calls[0][0]), "http://localhost");
        expect(first.pathname).toBe("/api/accounts/account-a/emojis/search");
        expect(first.searchParams.get("q")).toBe("🔥 & fire");
        expect(first.searchParams.get("emoticon")).toBeNull();
        expect(first.searchParams.get("offset")).toBe("0");
        expect(first.searchParams.get("lang")?.split(",")).toContain("en");
        expect(search.state).toEqual({
            choices: [fire],
            loading: false,
            error: "",
            nextOffset: 100,
        });

        search.loadMore();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        const next = new URL(String(fetch.mock.calls[1][0]), "http://localhost");
        expect(next.searchParams.get("q")).toBe("🔥 & fire");
        expect(next.searchParams.get("offset")).toBe("100");
        expect(search.state).toEqual({
            choices: [fire, heart],
            loading: false,
            error: "",
            nextOffset: null,
        });
        search.setQuery("");
        expect(search.state.choices).toEqual([]);
        expect(search.find(heart.id)).toEqual(heart);
        search.dispose();
    });

    test("sends emoji-only queries as space-separated graphemes", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            Response.json({ choices: [fire], next_offset: null }),
        );
        const search = createEmojiSearch(accountApi("account-a"));
        search.setQuery("👩🏽‍💻🇺🇦 1️⃣");
        await debounce();
        const url = new URL(String(fetch.mock.calls[0][0]), "http://localhost");
        expect(url.searchParams.get("q")).toBe("👩🏽‍💻🇺🇦 1️⃣");
        expect(url.searchParams.get("emoticon")).toBe("👩🏽‍💻 🇺🇦 1️⃣");
        search.dispose();
    });

    test("ignores old responses after the query changes or is cleared", async () => {
        let respond!: (response: Response) => void;
        const slow = new Promise<Response>((resolve) => {
            respond = resolve;
        });
        const fetch = spyOn(globalThis, "fetch")
            .mockReturnValueOnce(slow)
            .mockResolvedValueOnce(Response.json({ choices: [heart], next_offset: null }));
        const search = createEmojiSearch(accountApi("account-a"));
        search.setQuery("fire");
        await debounce();
        search.setQuery("heart");
        await debounce();
        expect(search.state.choices).toEqual([heart]);
        respond(Response.json({ choices: [fire], next_offset: null }));
        await settle();
        expect(search.state.choices).toEqual([heart]);
        expect(search.find(fire.id)).toBeUndefined();
        search.setQuery("another");
        search.setQuery(" ");
        await debounce();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(search.state).toEqual({ choices: [], loading: false, error: "", nextOffset: null });
        search.dispose();
    });

    test("does not request the same page twice while it is loading", async () => {
        let respond!: (response: Response) => void;
        const slow = new Promise<Response>((resolve) => {
            respond = resolve;
        });
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ choices: [fire], next_offset: 42 }))
            .mockReturnValueOnce(slow);
        const search = createEmojiSearch(accountApi("account-a"));
        search.setQuery("fire");
        await debounce();
        search.loadMore();
        search.loadMore();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(search.state.loading).toBe(true);
        respond(Response.json({ choices: [heart], next_offset: null }));
        await settle();
        expect(search.state.choices).toEqual([fire, heart]);
        search.loadMore();
        expect(fetch).toHaveBeenCalledTimes(2);
        search.dispose();
    });

    test("retries a failed page without losing the first page", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ choices: [fire], next_offset: 42 }))
            .mockRejectedValueOnce(new Error("Network unavailable"))
            .mockResolvedValueOnce(Response.json({ choices: [heart], next_offset: null }));
        const search = createEmojiSearch(accountApi("account-a"));
        search.setQuery("fire");
        await debounce();
        search.loadMore();
        await settle();
        expect(search.state.choices).toEqual([fire]);
        expect(search.state.error).toBe("Cannot reach Celine.");
        search.retry();
        await settle();
        expect(search.state.choices).toEqual([fire, heart]);
        expect(search.state.error).toBe("");
        const retry = new URL(String(fetch.mock.calls[2][0]), "http://localhost");
        expect(retry.searchParams.get("offset")).toBe("42");
        search.dispose();
    });

    test("keeps search results separate between accounts and cancels scheduled work on dispose", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            Response.json({ choices: [fire], next_offset: null }),
        );
        const personal = createEmojiSearch(accountApi("personal"));
        const work = createEmojiSearch(accountApi("work"));
        personal.setQuery("fire");
        work.setQuery("heart");
        work.dispose();
        await debounce();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(personal.find(fire.id)).toEqual(fire);
        expect(work.find(fire.id)).toBeUndefined();
        personal.dispose();
    });
});
