import { createSignal, onCleanup, Show } from "solid-js";

export function AvatarVideo(props: { url?: string | null; poster?: string | null }) {
    const motion = matchMedia("(prefers-reduced-motion: no-preference)");
    const [allowed, setAllowed] = createSignal(motion.matches);
    const [failedUrl, setFailedUrl] = createSignal<string>();
    const updateMotion = () => setAllowed(motion.matches);
    motion.addEventListener("change", updateMotion);
    onCleanup(() => motion.removeEventListener("change", updateMotion));

    return (
        <Show when={allowed() && props.url && props.url !== failedUrl() && props.url}>
            {(url) => (
                <video
                    class="avatar-video"
                    src={url()}
                    poster={props.poster ?? undefined}
                    muted
                    autoplay
                    loop
                    playsinline
                    aria-hidden="true"
                    onError={() => setFailedUrl(url())}
                />
            )}
        </Show>
    );
}
