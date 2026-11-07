type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | { [key: string]: JsonValue | undefined };

export type EmojiAnimation = EmojiComposition & { assets?: readonly EmojiComposition[] };

type EmojiComposition = {
    [key: string]: JsonValue | undefined;
    layers?: readonly {
        [key: string]: JsonValue | undefined;
        masksProperties?: readonly { [key: string]: JsonValue | undefined }[];
    }[];
};

async function parseEmojiAnimation(response: Response): Promise<EmojiAnimation> {
    const value: JsonValue = await response.json();
    if (!isRecord(value) || !Array.isArray(value.layers)) {
        throw new Error("Invalid emoji animation.");
    }
    validateComposition(value);
    if (value.assets !== undefined) {
        if (!Array.isArray(value.assets)) throw new Error("Invalid emoji animation assets.");
        for (const asset of value.assets) validateComposition(asset);
    }
    // Unrelated Lottie properties remain untouched.
    // SAFETY: root, compositions, layers and mask objects are validated above.
    return value as EmojiAnimation;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue | undefined } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateComposition(value: JsonValue): void {
    if (!isRecord(value)) throw new Error("Invalid emoji composition.");
    if (value.layers === undefined) return;
    if (!Array.isArray(value.layers)) throw new Error("Invalid emoji layers.");
    for (const layer of value.layers) {
        if (!isRecord(layer)) throw new Error("Invalid emoji layer.");
        if (layer.masksProperties === undefined) continue;
        if (!Array.isArray(layer.masksProperties)) throw new Error("Invalid emoji masks.");
        for (const mask of layer.masksProperties) {
            if (!isRecord(mask)) throw new Error("Invalid emoji mask.");
        }
    }
}

type EmojiData =
    | { format: "tgs"; animationData: EmojiAnimation }
    | { format: "image" | "webm"; blob: Blob };

type EncodedMedia = { format: "tgs"; blob: Blob } | { format: "image" | "webm"; blob: Blob };

// Keep compressed artwork across picker tabs without retaining parsed Lottie data.
const cacheBudget = 4 * 1024 * 1024;
const mediaCache = new Map<string, EncodedMedia>();
let cachedBytes = 0;

export async function loadEmojiMedia(url: string, signal: AbortSignal): Promise<EmojiData> {
    signal.throwIfAborted();
    const cached = mediaCache.get(url);
    const media = cached ?? (await fetchEmojiMedia(url, signal));
    // Lottie mutates animation data; decode compressed bytes separately for each renderer.
    const data: EmojiData =
        media.format === "tgs"
            ? {
                  format: "tgs",
                  animationData: await parseEmojiAnimation(
                      new Response(
                          media.blob.stream().pipeThrough(new DecompressionStream("gzip")),
                      ),
                  ),
              }
            : media;
    signal.throwIfAborted();
    cacheMedia(url, media);
    return data;
}

function cacheMedia(url: string, media: EncodedMedia): void {
    const previous = mediaCache.get(url);
    if (previous) {
        mediaCache.delete(url);
        cachedBytes -= previous.blob.size;
    }
    // Empty and oversized responses can render, but do not consume cache entries.
    if (!media.blob.size || media.blob.size > cacheBudget) return;
    for (const [key, oldest] of mediaCache) {
        if (cachedBytes + media.blob.size <= cacheBudget) break;
        mediaCache.delete(key);
        cachedBytes -= oldest.blob.size;
    }
    mediaCache.set(url, media);
    cachedBytes += media.blob.size;
}

async function fetchEmojiMedia(url: string, signal: AbortSignal): Promise<EncodedMedia> {
    const response = await fetch(url, { signal, credentials: "same-origin", redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Emoji media unavailable.");
    const contentType = response.headers.get("Content-Type")?.split(";")[0].trim();
    if (contentType === "application/x-tgsticker") {
        return { format: "tgs", blob: await response.blob() };
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
