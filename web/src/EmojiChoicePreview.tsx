import { createSignal, onSettled, Show } from "solid-js";
import { EmojiMedia } from "./EmojiMedia";

const previews = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver;

export function EmojiChoicePreview(props: {
    active: boolean;
    url: string;
    label: string;
    textColor?: boolean;
}) {
    const [visible, setVisible] = createSignal(false);
    let preview!: HTMLSpanElement;

    onSettled(() => {
        observer ??= new IntersectionObserver((entries) => {
            for (const entry of entries) {
                previews.get(entry.target)?.(entry.isIntersecting);
            }
        });
        previews.set(preview, setVisible);
        observer.observe(preview);
        return () => {
            observer.unobserve(preview);
            previews.delete(preview);
        };
    });

    return (
        <span
            class="emoji-preview"
            aria-hidden="true"
            ref={(element) => {
                preview = element;
            }}
        >
            <Show when={props.active && visible()}>
                <EmojiMedia url={props.url} label={props.label} textColor={props.textColor} />
            </Show>
        </span>
    );
}
