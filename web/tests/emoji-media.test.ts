import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { loadEmojiMedia } from "../src/emoji-media";

let nextId = 0;
let url: string;
beforeEach(() => {
    url = `/api/emojis/${++nextId}/media`;
});
afterEach(() => mock.restore());

describe("emoji media", () => {
    test("decompresses actual TGS bytes instead of treating animation as a thumbnail", async () => {
        const animation = { v: "5.7.4", fr: 30, ip: 0, op: 60, w: 32, h: 32, layers: [] };
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(Bun.gzipSync(JSON.stringify(animation)), {
                headers: { "Content-Type": "application/x-tgsticker" },
            }),
        );
        const signal = new AbortController().signal;
        expect(await loadEmojiMedia(url, signal)).toEqual({
            format: "tgs",
            animationData: animation,
        });
        expect(fetch.mock.calls[0]).toEqual([
            url,
            { signal, credentials: "same-origin", redirect: "error" },
        ]);
    });

    test.each(["video/webm", "image/webp", "image/png", "image/jpeg"])(
        "keeps %s as binary media",
        async (contentType) => {
            spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(new Uint8Array([1, 2, 3]), {
                    headers: { "Content-Type": contentType },
                }),
            );
            const result = await loadEmojiMedia(`${url}/cover`, new AbortController().signal);
            expect(result.format).toBe(contentType === "video/webm" ? "webm" : "image");
            if (result.format === "tgs") throw new Error("Expected binary media.");
            expect(result.blob.type).toBe(contentType);
            expect([...new Uint8Array(await result.blob.arrayBuffer())]).toEqual([1, 2, 3]);
        },
    );

    test("accepts a MIME type with parameters", async () => {
        spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("image", {
                headers: { "Content-Type": "image/webp; charset=binary" },
            }),
        );
        expect((await loadEmojiMedia(url, new AbortController().signal)).format).toBe("image");
    });

    test("rejects unavailable media so the renderer can replace its skeleton with a fallback", async () => {
        spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
        await expect(loadEmojiMedia(url, new AbortController().signal)).rejects.toThrow(
            "Emoji media unavailable.",
        );
    });

    test.each(["text/html", "image/svg+xml", "application/json"])(
        "does not render %s as emoji artwork",
        async (contentType) => {
            spyOn(globalThis, "fetch").mockResolvedValue(
                new Response("not emoji media", {
                    headers: { "Content-Type": contentType },
                }),
            );
            await expect(loadEmojiMedia(url, new AbortController().signal)).rejects.toThrow(
                "Unsupported emoji media.",
            );
        },
    );

    test("rejects corrupt TGS rather than leaving an unresolved loading state", async () => {
        spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("not gzip", {
                headers: { "Content-Type": "application/x-tgsticker" },
            }),
        );
        await expect(loadEmojiMedia(url, new AbortController().signal)).rejects.toThrow();
    });

    test("reuses loaded artwork after its renderer is disposed", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("image", {
                headers: { "Content-Type": "image/webp" },
            }),
        );
        const first = new AbortController();
        const loaded = await loadEmojiMedia(url, first.signal);
        first.abort();
        expect(await loadEmojiMedia(url, new AbortController().signal)).toBe(loaded);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test("gives each Lottie renderer a fresh copy of cached animation data", async () => {
        const animation = { layers: [{ nm: "original" }] };
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(Bun.gzipSync(JSON.stringify(animation)), {
                headers: { "Content-Type": "application/x-tgsticker" },
            }),
        );
        const first = await loadEmojiMedia(url, new AbortController().signal);
        if (first.format !== "tgs") throw new Error("Expected TGS.");
        // SAFETY: this animation was decoded from the fixture returned by the mocked fetch above.
        (first.animationData as typeof animation).layers[0].nm = "mutated by renderer";
        expect(await loadEmojiMedia(url, new AbortController().signal)).toEqual({
            format: "tgs",
            animationData: animation,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test("retries failures rather than caching them", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(
                new Response("image", { headers: { "Content-Type": "image/webp" } }),
            );
        await expect(loadEmojiMedia(url, new AbortController().signal)).rejects.toThrow();
        expect((await loadEmojiMedia(url, new AbortController().signal)).format).toBe("image");
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test("rejects an already cancelled load even when artwork is cached", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("image", {
                headers: { "Content-Type": "image/webp" },
            }),
        );
        await loadEmojiMedia(url, new AbortController().signal);
        const abort = new AbortController();
        abort.abort();
        await expect(loadEmojiMedia(url, abort.signal)).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test("propagates cancellation when an emoji leaves the visible picker", async () => {
        const abort = new AbortController();
        const failure = new DOMException("Aborted", "AbortError");
        const fetch = spyOn(globalThis, "fetch").mockRejectedValue(failure);
        await expect(loadEmojiMedia(url, abort.signal)).rejects.toBe(failure);
        expect(fetch.mock.calls[0][1]?.signal).toBe(abort.signal);
        fetch.mockResolvedValueOnce(
            new Response("image", { headers: { "Content-Type": "image/webp" } }),
        );
        expect((await loadEmojiMedia(url, new AbortController().signal)).format).toBe("image");
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
