import { createEffect, createMemo, createSignal, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import lottie from "lottie-web/build/player/lottie_light";
import type { AnimationItem } from "lottie-web";
import { loadEmojiMedia } from "./emoji-media";

export function EmojiMedia(props: {
    url?: string | null;
    label: string;
    textColor?: boolean;
    revision?: number;
    fallback?: JSX.Element;
}) {
    const url = createMemo(() => props.url);
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
        () => ({ url: url(), visible: visible(), attempt: attempt() }),
        ({ url, visible }) => {
            setLoading(true);
            setFailed(false);
            if (!url || !visible) return;
            const abort = new AbortController();
            let animation: AnimationItem | undefined;
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
                    animation = lottie.loadAnimation({
                        container: content,
                        renderer: "svg",
                        loop: true,
                        autoplay: animate,
                        animationData: data.animationData,
                    });
                    animation.addEventListener("DOMLoaded", ready);
                    animation.addEventListener("data_failed", fail);
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
