import { createEffect, createMemo, createSignal, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { AnimationItem } from "lottie-web";
import { loadEmojiMedia } from "./emoji-media";
import { emojiRenderer } from "./emoji-renderer";
import { emojiAnimations } from "./emoji-animation";

export function EmojiMedia(props: {
    url?: string | null;
    label: string;
    textColor?: boolean;
    revision?: number;
    fallback?: JSX.Element;
}) {
    // State polls replace parent objects; reload artwork only when these values change.
    const url = createMemo(() => props.url);
    const textColor = createMemo(() => props.textColor);
    const [visible, setVisible] = createSignal(false);
    const [loading, setLoading] = createSignal(true);
    const [failed, setFailed] = createSignal(false);
    const [attempt, setAttempt] = createSignal(0);
    let wrapper!: HTMLSpanElement;
    let content!: HTMLSpanElement;

    onSettled(() => {
        const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
        observer.observe(wrapper);
        return () => observer.disconnect();
    });
    createEffect(
        () => props.revision,
        (revision, previous) => {
            if (revision !== previous && untrack(failed)) setAttempt((value) => value + 1);
        },
    );
    createEffect(
        () => ({ url: url(), visible: visible(), attempt: attempt(), textColor: textColor() }),
        ({ url, visible, textColor }) => {
            setLoading(true);
            setFailed(false);
            if (!url || !visible) return;
            const abort = new AbortController();
            let animation: AnimationItem | undefined;
            let resizeObserver: ResizeObserver | undefined;
            let resolution: MediaQueryList | undefined;
            let detach: (() => void) | undefined;
            const refreshResolution = () => setAttempt((value) => value + 1);
            let media: HTMLImageElement | HTMLVideoElement | undefined;
            let objectUrl: string | undefined;
            const ready = () => {
                if (!abort.signal.aborted) setLoading(false);
            };
            const fail = () => {
                if (!abort.signal.aborted) setFailed(true);
            };

            async function render(source: string) {
                const data = await loadEmojiMedia(source, abort.signal);
                if (abort.signal.aborted) return;

                const animate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
                if (data.format === "tgs") {
                    const animationData = data.animationData;
                    const renderer = emojiRenderer(animationData, textColor);
                    async function renderLottie() {
                        const { default: lottie } =
                            renderer === "svg"
                                ? await import("lottie-web/build/player/lottie_light")
                                : await import("lottie-web/build/player/lottie_light_canvas");
                        if (abort.signal.aborted) return;
                        animation = lottie.loadAnimation({
                            container: content,
                            renderer,
                            loop: true,
                            autoplay: animate,
                            animationData,
                        });
                        animation.addEventListener("DOMLoaded", () => {
                            if (renderer === "canvas" && !abort.signal.aborted) {
                                // Canvas backing dimensions must follow the rendered emoji size.
                                // Lottie applies devicePixelRatio when resizing the backing store.
                                // Hidden pickers report zero size, which Lottie cannot render.
                                resizeObserver = new ResizeObserver(([entry]) => {
                                    if (entry.contentRect.width && entry.contentRect.height) {
                                        animation?.resize();
                                    }
                                });
                                resizeObserver.observe(content);
                            }
                            ready();
                        });
                        animation.addEventListener("data_failed", fail);
                    }
                    if (renderer === "canvas") {
                        resolution = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
                        resolution.addEventListener("change", refreshResolution);
                    }
                    // TLottie's load event precedes presentation of its first frame.
                    // Use Lottie for still frames so reduced-motion artwork cannot stay blank.
                    if (renderer === "svg" || !animate) {
                        await renderLottie();
                        return;
                    }
                    let fallbackStarted = false;
                    const fallback = () => {
                        if (fallbackStarted || abort.signal.aborted) return;
                        fallbackStarted = true;
                        resizeObserver?.disconnect();
                        detach?.();
                        detach = undefined;
                        void renderLottie().catch(fail);
                    };
                    try {
                        const registry = await emojiAnimations();
                        if (abort.signal.aborted) return;
                        let previousWidth = 0;
                        let previousHeight = 0;
                        resizeObserver = new ResizeObserver(([entry]) => {
                            const { width, height } = entry.contentRect;
                            if (
                                !width ||
                                !height ||
                                (width === previousWidth && height === previousHeight)
                            )
                                return;
                            previousWidth = width;
                            previousHeight = height;
                            detach?.();
                            detach = undefined;
                            try {
                                detach = registry.subscribe({
                                    url: source,
                                    width,
                                    height,
                                    dpr: devicePixelRatio,
                                    data: animationData,
                                    container: content,
                                    ready,
                                    error: fallback,
                                });
                            } catch {
                                fallback();
                            }
                        });
                        resizeObserver.observe(content);
                    } catch {
                        fallback();
                    }
                } else {
                    if (data.format === "webm") {
                        const video = document.createElement("video");
                        video.autoplay = animate;
                        video.loop = true;
                        video.muted = true;
                        video.playsInline = true;
                        media = video;
                    } else {
                        const image = document.createElement("img");
                        image.alt = "";
                        media = image;
                    }
                    media.draggable = false;
                    media.addEventListener(data.format === "webm" ? "loadeddata" : "load", ready, {
                        once: true,
                    });
                    media.addEventListener("error", fail, { once: true });
                    objectUrl = URL.createObjectURL(data.blob);
                    media.src = objectUrl;
                    content.append(media);
                }
            }

            void render(url).catch(fail);
            return () => {
                abort.abort();
                resolution?.removeEventListener("change", refreshResolution);
                resizeObserver?.disconnect();
                detach?.();
                animation?.destroy();
                if (media instanceof HTMLVideoElement) {
                    media.pause();
                    media.removeAttribute("src");
                    media.load();
                }
                media?.remove();
                if (objectUrl) URL.revokeObjectURL(objectUrl);
            };
        },
    );

    return (
        <span
            class={["emoji-media", { "text-color": props.textColor }]}
            role="img"
            aria-label={props.label}
            aria-busy={props.url && loading() && !failed() ? "true" : "false"}
            ref={(element) => {
                wrapper = element;
            }}
        >
            <Show when={props.url && loading() && !failed()}>
                <span class="emoji-skeleton" aria-hidden="true" />
            </Show>
            <span
                class={["emoji-art", { "emoji-art-loading": loading() || failed() }]}
                aria-hidden="true"
                ref={(element) => {
                    content = element;
                }}
            />
            <Show when={!props.url || failed()}>
                {props.fallback ?? <span class="emoji-fallback">{props.label}</span>}
            </Show>
        </span>
    );
}
