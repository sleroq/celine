import { createSignal, onSettled, Show } from "solid-js";
import { Portal, type JSX } from "@solidjs/web";
import { EmojiMedia } from "./EmojiMedia";
import { longPress } from "./long-press";

export function EmojiArtworkPreview(props: {
    url?: string;
    label: string;
    textColor?: boolean;
    enabled: boolean;
    children: (ref: (element: HTMLElement) => void) => JSX.Element;
}) {
    const [mount, setMount] = createSignal<HTMLElement>();
    let trigger!: HTMLElement;
    // Refs run before template nodes are adopted into the live document.
    // Register after insertion so gesture listeners use the page's ownerDocument.
    onSettled(() =>
        longPress(
            trigger,
            () => {
                if (!props.enabled || !props.url) return false;
                setMount(trigger.closest("dialog") ?? trigger.ownerDocument.body);
                return true;
            },
            () => setMount(undefined),
        ),
    );

    function attach(element: HTMLElement) {
        trigger = element;
    }

    return (
        <>
            {props.children(attach)}
            <Show when={mount()}>
                {(target) => (
                    <Portal mount={target()}>
                        <div
                            aria-hidden="true"
                            class="pointer-events-none fixed inset-0 z-[1000] grid place-items-center"
                        >
                            <div class="emoji-artwork-preview grid size-48 place-items-center rounded-3xl border border-border bg-surface/95 p-6 text-foreground shadow-lg">
                                <EmojiMedia
                                    url={props.url}
                                    label={props.label}
                                    textColor={props.textColor}
                                />
                            </div>
                        </div>
                    </Portal>
                )}
            </Show>
        </>
    );
}
