type EmojiData =
    | { format: "tgs"; animationData: unknown }
    | { format: "image" | "webm"; blob: Blob };

// Keep artwork across picker tabs, but not across page reloads.
const mediaCache = new Map<string, EmojiData>();

export async function loadEmojiMedia(url: string, signal: AbortSignal): Promise<EmojiData> {
    signal.throwIfAborted();
    let data = mediaCache.get(url);
    if (!data) {
        data = await fetchEmojiMedia(url, signal);
        signal.throwIfAborted();
        mediaCache.set(url, data);
    }
    // Lottie mutates animation data; each renderer needs its own copy.
    return data.format === "tgs"
        ? { format: "tgs", animationData: structuredClone(data.animationData) }
        : data;
}

async function fetchEmojiMedia(url: string, signal: AbortSignal): Promise<EmojiData> {
    const response = await fetch(url, { signal, credentials: "same-origin", redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Emoji media unavailable.");
    const contentType = response.headers.get("Content-Type")?.split(";")[0].trim();
    if (contentType === "application/x-tgsticker") {
        const json = new Response(response.body.pipeThrough(new DecompressionStream("gzip")));
        return { format: "tgs", animationData: await json.json() };
    }
    if (contentType === "video/webm") return { format: "webm", blob: await response.blob() };
    if (
        contentType === "image/webp" ||
        contentType === "image/png" ||
        contentType === "image/jpeg"
    ) {
        return { format: "image", blob: await response.blob() };
    }
    throw new Error("Unsupported emoji media.");
}
