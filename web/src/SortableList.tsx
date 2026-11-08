import { DefaultEmojiGlyph } from "./default-emoji";
import {
    createEffect,
    createMemo,
    createSignal,
    flush,
    For,
    onCleanup,
    onSettled,
    Show,
} from "solid-js";
import Sortable from "sortablejs";
import type { JSX } from "@solidjs/web";
import { moveItem } from "./api";
import { EmojiArtworkPreview } from "./EmojiArtworkPreview";
import { EmojiMedia } from "./EmojiMedia";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui";
import { t } from "./i18n";
import { resetTilt, tilt } from "./tilt";

const photoStatusIcons = {
    photoUploadNew: "M8 10V3m0 0L5 6m3-3 3 3M3 10v3h10v-3",
    photoReusable:
        "M13 3v3h-3M3 13v-3h3M3.5 6a5 5 0 0 1 8.3-1.8L13 6M3 10l1.2 1.8A5 5 0 0 0 12.5 10",
    photoUnavailable: "M5 5l6 6m0-6-6 6M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13",
    photoDuplicate: "M5 3H3v10h10v-2M6 1h8v8H6z",
    photoChecking: "M8 4v4l3 2M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13",
    photoUnknown:
        "M6 6a2 2 0 1 1 3 1.7c-1 .5-1 1-1 1.8M8 12v.1M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13",
};

type Item = {
    defaultEmoji?: boolean;
    id: string;
    label: string;
    imageUrl?: string;
    badge?: keyof typeof photoStatusIcons;
    badgeActionLabel?: string;
    mediaUrl?: string;
    textColor?: boolean;
    reorderLabel?: string;
    removeLabel?: string;
    editLabel?: string;
    current?: boolean;
    statusUrl?: string;
    statusLabel?: string;
    statusTextColor?: boolean;
};

type Props = {
    kind: "photo" | "emoji" | "appearance";
    renderPreview?: (id: string) => JSX.Element;
    items: Item[];
    busy: boolean;
    mediaActive?: boolean;
    reorder: (ids: string[]) => void;
    remove: (id: string) => void;
    recover?: (id: string) => void;
    trailing?: JSX.Element;
    edit?: (id: string, button: HTMLButtonElement) => void;
    editStatus?: (id: string, button: HTMLButtonElement) => void;
    preview?: (id: string, button: HTMLButtonElement) => void;
};

export function SortableList(props: Props) {
    const [announcement, setAnnouncement] = createSignal("");
    const [picked, setPicked] = createSignal<string>();
    const ids = () => props.items.map((item) => item.id);
    const itemsById = createMemo(() => new Map(props.items.map((item) => [item.id, item])));
    const hintId = () => `${props.kind}-reorder-hint`;
    let list!: HTMLOListElement;
    let sortable: Sortable | undefined;

    function move(from: number, to: number, animate = true) {
        setPicked(undefined);
        if (from === to) return;
        const elements =
            animate && matchMedia("(prefers-reduced-motion: no-preference)").matches
                ? Array.from(list.querySelectorAll<HTMLElement>(".sortable-item"))
                : [];
        const positions = elements.map((element) => element.getBoundingClientRect());
        setAnnouncement(
            t("reorderMoved", {
                name: props.items[from].label,
                position: to + 1,
                count: props.items.length,
            }),
        );
        props.reorder(moveItem(ids(), from, to));
        if (elements.length) {
            flush();
            elements.forEach((element, index) => {
                const next = element.getBoundingClientRect();
                const x = positions[index].left - next.left;
                const y = positions[index].top - next.top;
                if (x || y) {
                    element.animate(
                        [
                            { transform: `translate(${x}px, ${y}px)` },
                            { transform: "translate(0, 0)" },
                        ],
                        { duration: 180, easing: "ease-out" },
                    );
                }
            });
        }
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
                move(oldIndex, newIndex, false);
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
                <p id={hintId()} class="hint text-sm text-muted-foreground">
                    {t("reorderHint")}
                </p>
            </Show>
            <ol
                class={["sortable-list flex flex-wrap gap-3", `sortable-list-${props.kind}`]}
                aria-label={
                    props.kind === "appearance"
                        ? t("appearancePresets")
                        : props.kind === "photo"
                          ? t("reorderPhotoOrder")
                          : t("reorderEmojiOrder")
                }
                ref={(element) => {
                    list = element;
                }}
            >
                <For each={ids()}>
                    {(id, index) => {
                        const item = () => itemsById().get(id)!;

                        return (
                            <li
                                class="sortable-item relative"
                                onPointerMove={(event) =>
                                    tilt(event, props.kind === "appearance" ? 6 : 28)
                                }
                                onPointerLeave={resetTilt}
                                onPointerCancel={resetTilt}
                            >
                                <div class="sortable-surface relative">
                                    <EmojiArtworkPreview
                                        enabled={
                                            props.kind === "emoji" &&
                                            !props.busy &&
                                            props.mediaActive !== false
                                        }
                                        url={item().mediaUrl}
                                        label={item().label}
                                        textColor={item().textColor}
                                    >
                                        {(ref) => (
                                            <button
                                                ref={ref}
                                                type="button"
                                                class={[
                                                    "sortable-handle rounded-lg border bg-[Canvas] shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]",
                                                    props.kind === "emoji" && "photo-icon-action",
                                                    item().current &&
                                                        "border-accent! ring-2 ring-accent",
                                                ]}
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
                                                        event.key === "ArrowLeft" ||
                                                        event.key === "ArrowUp"
                                                            ? -1
                                                            : event.key === "ArrowRight" ||
                                                                event.key === "ArrowDown"
                                                              ? 1
                                                              : 0;
                                                    if (!direction || props.busy) return;
                                                    event.preventDefault();
                                                    const target = index() + direction;
                                                    if (target < 0 || target >= props.items.length)
                                                        return;
                                                    move(index(), target);
                                                    flush();
                                                    event.currentTarget.focus();
                                                }}
                                            >
                                                <Show
                                                    when={props.renderPreview}
                                                    fallback={
                                                        <Show
                                                            when={item().mediaUrl}
                                                            fallback={
                                                                <Show
                                                                    when={item().imageUrl}
                                                                    fallback={
                                                                        <Show
                                                                            when={
                                                                                item().defaultEmoji
                                                                            }
                                                                            fallback={
                                                                                <span class="sortable-fallback max-w-full truncate text-sm">
                                                                                    {item().label}
                                                                                </span>
                                                                            }
                                                                        >
                                                                            <DefaultEmojiGlyph />
                                                                        </Show>
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
                                                                    <Show
                                                                        when={
                                                                            props.mediaActive !==
                                                                            false
                                                                        }
                                                                    >
                                                                        <EmojiMedia
                                                                            url={url()}
                                                                            label={item().label}
                                                                            textColor={
                                                                                item().textColor
                                                                            }
                                                                        />
                                                                    </Show>
                                                                </span>
                                                            )}
                                                        </Show>
                                                    }
                                                >
                                                    {(render) => render()(id)}
                                                </Show>
                                            </button>
                                        )}
                                    </EmojiArtworkPreview>
                                    <Show when={item().current}>
                                        <span
                                            id={`${props.kind}-current-${id}`}
                                            class="visually-hidden"
                                        >
                                            {t("currentPhoto")}
                                        </span>
                                    </Show>
                                    <Show when={item().statusUrl}>
                                        {(url) => (
                                            <button
                                                type="button"
                                                class="photo-icon-action absolute -inset-s-2 -top-2 grid size-10 min-h-0 place-items-center rounded-md border border-border bg-surface/90 p-0.5 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                                aria-label={t("changeLinkedEmoji")}
                                                disabled={props.busy}
                                                onClick={(event) =>
                                                    props.editStatus?.(id, event.currentTarget)
                                                }
                                            >
                                                <EmojiMedia
                                                    url={url()}
                                                    label={item().statusLabel ?? t("emojiStatus")}
                                                    textColor={item().statusTextColor}
                                                />
                                            </button>
                                        )}
                                    </Show>
                                    <Show when={item().badge}>
                                        {(badge) => (
                                            <span class="pointer-events-none absolute inset-e-1 bottom-1 grid size-5 place-items-center rounded-md border border-border bg-surface/70 text-foreground shadow-sm">
                                                <Tooltip>
                                                    <Show
                                                        when={item().badgeActionLabel}
                                                        fallback={
                                                            <TooltipTrigger
                                                                as="span"
                                                                role="img"
                                                                tabindex="0"
                                                                aria-label={t("photoStatus")}
                                                                aria-describedby={`${props.kind}-badge-${id}`}
                                                                class="pointer-events-auto grid size-full place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                                            >
                                                                <svg
                                                                    aria-hidden="true"
                                                                    class="size-3.5 fill-none stroke-current stroke-[1.5]"
                                                                    stroke-linecap="round"
                                                                    stroke-linejoin="round"
                                                                    viewBox="0 0 16 16"
                                                                >
                                                                    <path
                                                                        d={
                                                                            photoStatusIcons[
                                                                                badge()
                                                                            ]
                                                                        }
                                                                    />
                                                                </svg>
                                                            </TooltipTrigger>
                                                        }
                                                    >
                                                        {(label) => (
                                                            <TooltipTrigger
                                                                as="button"
                                                                type="button"
                                                                class="photo-icon-action pointer-events-auto grid size-full min-h-0 place-items-center rounded-md border-0 bg-transparent p-0 text-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                                                aria-label={label()}
                                                                aria-describedby={`${props.kind}-badge-${id}`}
                                                                disabled={props.busy}
                                                                onClick={() => props.recover?.(id)}
                                                            >
                                                                <svg
                                                                    aria-hidden="true"
                                                                    class="size-3.5 fill-none stroke-current stroke-[1.5]"
                                                                    stroke-linecap="round"
                                                                    stroke-linejoin="round"
                                                                    viewBox="0 0 16 16"
                                                                >
                                                                    <path d="M8 11V5m0 0L5.5 7.5M8 5l2.5 2.5M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13" />
                                                                </svg>
                                                            </TooltipTrigger>
                                                        )}
                                                    </Show>
                                                    <TooltipContent>
                                                        {item().badgeActionLabel ?? t(badge())}
                                                    </TooltipContent>
                                                </Tooltip>
                                                <span
                                                    id={`${props.kind}-badge-${id}`}
                                                    class="visually-hidden sr-only"
                                                >
                                                    {t(badge())}
                                                </span>
                                            </span>
                                        )}
                                    </Show>
                                    <Show when={props.edit}>
                                        <button
                                            type="button"
                                            class="sortable-edit photo-icon-action shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                            aria-label={
                                                item().editLabel ??
                                                t("photoSettingsFor", {
                                                    name: item().label,
                                                })
                                            }
                                            disabled={props.busy}
                                            onClick={(event) =>
                                                props.edit?.(id, event.currentTarget)
                                            }
                                        >
                                            <svg aria-hidden="true" viewBox="0 0 24 24">
                                                <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                                            </svg>
                                        </button>
                                    </Show>
                                    <button
                                        type="button"
                                        class="sortable-remove photo-icon-action shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
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
                                </div>
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
