import { createEffect, createSignal, flush, For, onCleanup, onSettled, Show } from "solid-js";
import Sortable from "sortablejs";
import type { JSX } from "@solidjs/web";
import { moveItem } from "./api";
import { EmojiMedia } from "./EmojiMedia";
import { t } from "./i18n";
import { resetTilt, tilt } from "./tilt";

type Item = {
    id: string;
    label: string;
    imageUrl?: string;
    badge?: string;
    mediaUrl?: string;
    textColor?: boolean;
    reorderLabel?: string;
    removeLabel?: string;
    current?: boolean;
};

type Props = {
    kind: "photo" | "emoji";
    items: Item[];
    busy: boolean;
    reorder: (ids: string[]) => void;
    remove: (id: string) => void;
    trailing?: JSX.Element;
    edit?: (id: string, button: HTMLButtonElement) => void;
    preview?: (id: string, button: HTMLButtonElement) => void;
};

export function SortableList(props: Props) {
    const [announcement, setAnnouncement] = createSignal("");
    const [picked, setPicked] = createSignal<string>();
    const ids = () => props.items.map((item) => item.id);
    const hintId = () => `${props.kind}-reorder-hint`;
    let list!: HTMLOListElement;
    let sortable: Sortable | undefined;

    function move(from: number, to: number) {
        setPicked(undefined);
        if (from === to) return;
        setAnnouncement(
            t("reorderMoved", {
                name: props.items[from].label,
                position: to + 1,
                count: props.items.length,
            }),
        );
        props.reorder(moveItem(ids(), from, to));
    }

    function choose(id: string) {
        if (props.busy) return;
        const current = picked();
        if (current) {
            move(ids().indexOf(current), ids().indexOf(id));
        } else {
            setPicked(id);
            setAnnouncement(
                t("reorderSelected", { name: props.items.find((item) => item.id === id)!.label }),
            );
        }
    }

    onSettled(() => {
        sortable = Sortable.create(list, {
            handle: ".sortable-handle",
            draggable: ".sortable-item",
            onMove: (event) => !event.related.classList.contains("sortable-trailing"),
            ghostClass: "sortable-ghost",
            animation: matchMedia("(prefers-reduced-motion: no-preference)").matches ? 150 : 0,
            disabled: props.busy,
            onEnd(event) {
                const { oldIndex, newIndex } = event;
                if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
                // Sortable moves DOM nodes itself. Restore the DOM before Solid applies the new order.
                event.item.remove();
                event.from.insertBefore(event.item, event.from.children[oldIndex] ?? null);
                move(oldIndex, newIndex);
            },
        });
    });
    createEffect(
        () => props.busy,
        (busy) => {
            sortable?.option("disabled", busy);
        },
    );
    createEffect(ids, (items) => {
        const current = picked();
        if (current && !items.includes(current)) {
            setPicked(undefined);
            setAnnouncement("");
        }
    });
    onCleanup(() => sortable?.destroy());

    return (
        <>
            <Show when={props.items.length}>
                <p id={hintId()} class="hint text-sm text-[GrayText]">
                    {t("reorderHint")}
                </p>
            </Show>
            <ol
                class={["sortable-list flex flex-wrap gap-3", `sortable-list-${props.kind}`]}
                aria-label={
                    props.kind === "photo" ? t("reorderPhotoOrder") : t("reorderEmojiOrder")
                }
                ref={(element) => {
                    list = element;
                }}
            >
                <For each={ids()}>
                    {(id, index) => {
                        const item = () => props.items.find((candidate) => candidate.id === id)!;

                        return (
                            <li class="sortable-item relative">
                                <button
                                    type="button"
                                    class="sortable-handle rounded-lg border bg-[Canvas] shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                    onPointerMove={tilt}
                                    onPointerLeave={resetTilt}
                                    onPointerCancel={resetTilt}
                                    aria-label={
                                        item().reorderLabel ??
                                        (props.kind === "photo"
                                            ? t("reorderPhoto", { name: item().label })
                                            : t("reorderEmoji", { name: item().label }))
                                    }
                                    aria-describedby={[
                                        hintId(),
                                        item().badge && `${props.kind}-badge-${id}`,
                                        item().current && `${props.kind}-current-${id}`,
                                    ]
                                        .filter(Boolean)
                                        .join(" ")}
                                    aria-disabled={props.busy ? "true" : "false"}
                                    aria-pressed={picked() === id ? "true" : "false"}
                                    onClick={() => choose(id)}
                                    onDblClick={(event) => {
                                        if (!props.busy && props.preview) {
                                            setPicked(undefined);
                                            props.preview(id, event.currentTarget);
                                        }
                                    }}
                                    onKeyDown={(event) => {
                                        const direction =
                                            event.key === "ArrowLeft" || event.key === "ArrowUp"
                                                ? -1
                                                : event.key === "ArrowRight" ||
                                                    event.key === "ArrowDown"
                                                  ? 1
                                                  : 0;
                                        if (!direction || props.busy) return;
                                        event.preventDefault();
                                        const target = index() + direction;
                                        if (target < 0 || target >= props.items.length) return;
                                        move(index(), target);
                                        flush();
                                        event.currentTarget.focus();
                                    }}
                                >
                                    <Show
                                        when={item().mediaUrl}
                                        fallback={
                                            <Show
                                                when={item().imageUrl}
                                                fallback={
                                                    <span class="sortable-fallback max-w-full truncate text-sm">
                                                        {item().label}
                                                    </span>
                                                }
                                            >
                                                {(url) => (
                                                    <img
                                                        src={url()}
                                                        alt=""
                                                        loading="lazy"
                                                        draggable="false"
                                                    />
                                                )}
                                            </Show>
                                        }
                                    >
                                        {(url) => (
                                            <span aria-hidden="true">
                                                <EmojiMedia
                                                    url={url()}
                                                    label={item().label}
                                                    textColor={item().textColor}
                                                />
                                            </span>
                                        )}
                                    </Show>
                                    <Show when={item().badge}>
                                        <span
                                            class="photo-badge rounded-md shadow-sm"
                                            aria-hidden="true"
                                        >
                                            <svg viewBox="0 0 16 16">
                                                <path d="M8 10V3m0 0L5 6m3-3 3 3M3 10v3h10v-3" />
                                            </svg>
                                        </span>
                                    </Show>
                                </button>
                                <Show when={item().current}>
                                    <span
                                        id={`${props.kind}-current-${id}`}
                                        class="photo-current font-medium"
                                    >
                                        {t("currentPhoto")}
                                    </span>
                                </Show>
                                <Show when={item().badge}>
                                    {(badge) => (
                                        <span
                                            id={`${props.kind}-badge-${id}`}
                                            class="tooltip photo-tooltip rounded-md shadow-md"
                                            role="tooltip"
                                        >
                                            {badge()}
                                        </span>
                                    )}
                                </Show>
                                <Show when={props.edit}>
                                    <button
                                        type="button"
                                        class="sortable-edit shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                        aria-label={t("cropPhoto", { name: item().label })}
                                        disabled={props.busy}
                                        onClick={(event) => props.edit?.(id, event.currentTarget)}
                                    >
                                        <svg aria-hidden="true" viewBox="0 0 24 24">
                                            <path d="M6 3v12a3 3 0 0 0 3 3h12M3 6h12a3 3 0 0 1 3 3v12" />
                                        </svg>
                                    </button>
                                </Show>
                                <button
                                    type="button"
                                    class="sortable-remove shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                    aria-label={
                                        item().removeLabel ??
                                        (props.kind === "photo"
                                            ? t("reorderRemovePhoto", { name: item().label })
                                            : t("reorderRemoveEmoji", { name: item().label }))
                                    }
                                    disabled={props.busy}
                                    onClick={() => {
                                        setPicked(undefined);
                                        props.remove(id);
                                    }}
                                >
                                    <svg aria-hidden="true" viewBox="0 0 16 16">
                                        <path d="M4 4l8 8M12 4l-8 8" />
                                    </svg>
                                </button>
                            </li>
                        );
                    }}
                </For>
                <Show when={props.trailing}>
                    <li class="sortable-trailing">{props.trailing}</li>
                </Show>
            </ol>
            <span class="visually-hidden sr-only" aria-live="polite">
                {announcement()}
            </span>
        </>
    );
}
