import { DEFAULT_EMOJI_ID, DefaultEmojiGlyph } from "./default-emoji";
import {
    createEffect,
    createSignal,
    createUniqueId,
    For,
    onCleanup,
    onSettled,
    Show,
    untrack,
} from "solid-js";
import type { AccountApi, EmojiChoice } from "./api";
import { createAutosave } from "./autosave";
import { createEmojiPacks } from "./emoji-packs";
import { createEmojiSearch } from "./emoji-search";
import { emojiDisplayName } from "./display-names";
import { EmojiMedia } from "./EmojiMedia";
import { EmojiArtworkPreview } from "./EmojiArtworkPreview";
import { EmojiChoicePreview } from "./EmojiChoicePreview";
import { SortableList } from "./SortableList";
import { resetTilt, tilt } from "./tilt";
import { t } from "./i18n";
import { Button, TextField, TextFieldInput, TextFieldLabel } from "./components/ui";
function emojiSource(emoji: EmojiChoice): string {
    if (emoji.source_kind === "recent") return t("emojiSourceRecent");
    if (emoji.source_kind === "default") return t("emojiSourceDefault");
    if (emoji.source_kind === "collectible") return t("collectibleEmojiStatuses");
    if (emoji.source_kind === "search") return t("emojiSearchResults");
    return emoji.source;
}

export function EmojiChoices(props: {
    active: boolean;
    choices: EmojiChoice[];
    api: AccountApi;
    selected: string[];
    busy: boolean;
    toggle: (id: string) => void;
    single?: boolean;
}) {
    const groupName = createUniqueId();

    return (
        <div class="emojis">
            <For each={props.choices}>
                {(emoji) => (
                    <EmojiArtworkPreview
                        enabled={props.active && !props.busy}
                        url={props.api.emojiMediaUrl(emoji.document_id ?? emoji.id)}
                        label={emojiDisplayName(emoji.label)}
                        textColor={emoji.text_color}
                    >
                        {(ref) => (
                            <label
                                ref={ref}
                                class="emoji-choice"
                                title={
                                    emoji.source_kind === "collectible"
                                        ? emojiDisplayName(emoji.label)
                                        : emojiSource(emoji)
                                }
                                onPointerMove={tilt}
                                onPointerLeave={resetTilt}
                                onPointerCancel={resetTilt}
                            >
                                <input
                                    type={props.single ? "radio" : "checkbox"}
                                    name={props.single ? groupName : undefined}
                                    aria-label={`${emojiDisplayName(emoji.label)} (${emojiSource(emoji)})`}
                                    checked={props.selected.includes(emoji.id)}
                                    disabled={props.busy}
                                    onChange={() => props.toggle(emoji.id)}
                                />
                                <EmojiChoicePreview
                                    active={props.active}
                                    url={props.api.emojiMediaUrl(emoji.document_id ?? emoji.id)}
                                    label={emojiDisplayName(emoji.label)}
                                    textColor={emoji.text_color}
                                />
                            </label>
                        )}
                    </EmojiArtworkPreview>
                )}
            </For>
        </div>
    );
}

function EmojiSearchMore(props: { loadMore: () => void }) {
    let sentinel!: HTMLDivElement;
    onSettled(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) props.loadMore();
            },
            { root: sentinel.parentElement, rootMargin: "0px 0px 160px" },
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    });
    return (
        <div
            class="h-px"
            aria-hidden="true"
            ref={(element) => {
                sentinel = element;
            }}
        />
    );
}

export function EmojiPicker(props: {
    api: AccountApi;
    busy: boolean;
    single?: boolean;
    choose?: (id: string | null) => void;
    dismiss?: () => void;
    active: boolean;
    notify: (message: string, action?: () => void) => void;
    selected: string[];
    selectedEmojis: EmojiChoice[];
    premium: boolean;
    autosave?: ReturnType<typeof createAutosave<string[]>>;
}) {
    // The keyed account workspace owns this catalog for the lifetime of its account API.
    const packs = untrack(() => createEmojiPacks(props.api));
    const search = untrack(() => createEmojiSearch(props.api));
    const [pickerOpen, setPickerOpen] = createSignal(untrack(() => !!props.single));
    let addButton!: HTMLButtonElement;
    const artworkActive = () => props.active && pickerOpen();
    const selected = () => props.autosave?.draft() ?? props.selected;

    createEffect(
        () => props.premium && pickerOpen(),
        (open, wasOpen) => {
            if (open && !wasOpen) untrack(() => void packs.select());
        },
    );
    createEffect(
        () => [packs.activeId, packs.active?.error] as const,
        ([id, message], previous) => {
            if (message && (id !== previous?.[0] || message !== previous?.[1])) {
                props.notify(message, () => void packs.select(id));
            }
        },
    );

    function save(ids: string[]) {
        props.autosave?.edit(ids);
    }

    function toggle(id: string) {
        if (props.single) {
            props.choose?.(id === DEFAULT_EMOJI_ID ? null : id);
            return;
        }
        save(
            selected().includes(id)
                ? selected().filter((item) => item !== id)
                : [...selected(), id],
        );
    }

    function closePicker() {
        search.setQuery("");
        setPickerOpen(false);
        addButton.focus();
    }

    function selectPack(id: string) {
        search.setQuery("");
        void packs.select(id);
    }

    onCleanup(search.dispose);

    return (
        <section aria-label={t("customEmoji")}>
            <Show when={props.premium}>
                <Show when={!props.single}>
                    <SortableList
                        kind="emoji"
                        busy={props.busy}
                        mediaActive={props.active}
                        reorder={save}
                        remove={toggle}
                        items={selected().map((id) => {
                            const choice =
                                packs.find(id) ??
                                search.find(id) ??
                                props.selectedEmojis.find((emoji) => emoji.id === id);
                            return {
                                id,
                                label:
                                    id === DEFAULT_EMOJI_ID
                                        ? t("noEmojiStatus")
                                        : emojiDisplayName(choice?.label ?? id),
                                mediaUrl:
                                    id === DEFAULT_EMOJI_ID
                                        ? undefined
                                        : props.api.emojiMediaUrl(choice?.document_id ?? id),
                                defaultEmoji: id === DEFAULT_EMOJI_ID,
                                textColor: choice?.text_color,
                            };
                        })}
                        trailing={
                            <button
                                type="button"
                                class="emoji-add photo-icon-action"
                                aria-label={t("addEmoji")}
                                aria-expanded={pickerOpen() ? "true" : "false"}
                                aria-controls="emoji-browser"
                                ref={(element) => {
                                    addButton = element;
                                }}
                                onClick={() => (pickerOpen() ? closePicker() : setPickerOpen(true))}
                            >
                                <svg aria-hidden="true" viewBox="0 0 24 24">
                                    <path d="M12 5v14M5 12h14" />
                                </svg>
                            </button>
                        }
                    />
                </Show>
                <div
                    id={props.single ? "photo-emoji-browser" : "emoji-browser"}
                    class="emoji-browser"
                    hidden={!pickerOpen()}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            if (search.query) search.setQuery("");
                            else if (props.single) props.dismiss?.();
                            else closePicker();
                        }
                    }}
                >
                    <TextField class="mb-3">
                        <TextFieldLabel class="visually-hidden">{t("searchEmoji")}</TextFieldLabel>
                        <TextFieldInput
                            type="search"
                            placeholder={t("searchEmoji")}
                            value={search.query}
                            onInput={(event) => search.setQuery(event.currentTarget.value)}
                        />
                    </TextField>
                    <nav class="emoji-packs" aria-label={t("emojiPacks")}>
                        <button
                            type="button"
                            aria-label={t("recentDefault")}
                            title={t("recentDefault")}
                            aria-pressed={
                                !search.query.trim() && packs.activeId === "" ? "true" : "false"
                            }
                            aria-controls={
                                props.single ? "photo-emoji-pack-choices" : "emoji-pack-choices"
                            }
                            onClick={() => selectPack("")}
                        >
                            <svg class="pack-glyph" aria-hidden="true" viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="8" />
                                <path d="M12 7v5l3 2" />
                            </svg>
                        </button>
                        <For each={packs.sets}>
                            {(set) => (
                                <button
                                    type="button"
                                    aria-label={set.title}
                                    title={set.title}
                                    aria-pressed={
                                        !search.query.trim() && packs.activeId === set.id
                                            ? "true"
                                            : "false"
                                    }
                                    aria-controls={
                                        props.single
                                            ? "photo-emoji-pack-choices"
                                            : "emoji-pack-choices"
                                    }
                                    onClick={() => selectPack(set.id)}
                                >
                                    <span aria-hidden="true">
                                        <Show when={artworkActive()}>
                                            <EmojiMedia
                                                url={set.cover_url}
                                                label={set.title}
                                                textColor={set.text_color}
                                                fallback={
                                                    <svg class="pack-glyph" viewBox="0 0 24 24">
                                                        <rect
                                                            x="5"
                                                            y="3"
                                                            width="14"
                                                            height="18"
                                                            rx="3"
                                                        />
                                                        <path d="M8 8h8M8 12h8M8 16h4" />
                                                    </svg>
                                                }
                                            />
                                        </Show>
                                    </span>
                                </button>
                            )}
                        </For>
                        <Show when={!packs.sets.length && (!packs.active || packs.active.loading)}>
                            <For each={[0, 1, 2, 3, 4, 5]}>
                                {() => (
                                    <span class="pack-skeleton" aria-hidden="true">
                                        <span class="emoji-skeleton" />
                                    </span>
                                )}
                            </For>
                        </Show>
                    </nav>
                    <div
                        id={props.single ? "photo-emoji-pack-choices" : "emoji-pack-choices"}
                        class="emoji-pack-choices"
                        role="region"
                        aria-labelledby={
                            props.single ? "photo-emoji-pack-title" : "emoji-pack-title"
                        }
                        aria-busy={
                            (search.query.trim() ? search.state.loading : packs.active?.loading)
                                ? "true"
                                : "false"
                        }
                    >
                        <Show when={!search.query.trim()}>
                            <div class="flex items-center justify-between gap-2">
                                <h2
                                    id={
                                        props.single ? "photo-emoji-pack-title" : "emoji-pack-title"
                                    }
                                    class="text-base"
                                >
                                    {packs.title}
                                </h2>
                                <Show when={!packs.activeId}>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        class="size-8 min-h-8 aria-disabled:opacity-55"
                                        aria-label={t("refreshEmojiStatuses")}
                                        title={t("refreshEmojiStatuses")}
                                        aria-disabled={packs.active?.loading ? "true" : undefined}
                                        onClick={() => void packs.select("")}
                                    >
                                        <svg
                                            aria-hidden="true"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                        >
                                            <path d="M20 11a8 8 0 0 0-14-5L4 8m0-4v4h4M4 13a8 8 0 0 0 14 5l2-2m0 4v-4h-4" />
                                        </svg>
                                    </Button>
                                </Show>
                            </div>
                            <Show when={!packs.activeId}>
                                <div class="emojis">
                                    <label class="emoji-choice" title={t("noEmojiStatus")}>
                                        <input
                                            type={props.single ? "radio" : "checkbox"}
                                            aria-label={t("noEmojiStatus")}
                                            checked={
                                                selected().includes(DEFAULT_EMOJI_ID) ||
                                                (!!props.single && !selected().length)
                                            }
                                            disabled={props.busy}
                                            onChange={() => toggle(DEFAULT_EMOJI_ID)}
                                        />
                                        <DefaultEmojiGlyph />
                                    </label>
                                </div>
                            </Show>
                            <Show when={!packs.active || packs.active.loading}>
                                <p class="visually-hidden" role="status">
                                    {t("loadingEmoji")}
                                </p>
                                <div class="emojis" aria-hidden="true">
                                    <For
                                        each={Array.from(
                                            { length: Math.min(packs.count || 24, 36) },
                                            (_, index) => index,
                                        )}
                                    >
                                        {() => (
                                            <span class="emoji-preview">
                                                <span class="emoji-skeleton" />
                                            </span>
                                        )}
                                    </For>
                                </div>
                            </Show>
                            <Show when={packs.active?.error}>
                                <button type="button" onClick={() => void packs.select()}>
                                    {t("retry")}
                                </button>
                            </Show>
                            <Show when={packs.active?.choices}>
                                <For each={packs.groups}>
                                    {(group) => (
                                        <section class={group.kind === "pack" ? "m-0" : undefined}>
                                            <Show when={group.kind !== "pack"}>
                                                <h3 class="mt-4 mb-1 text-sm font-semibold text-muted-foreground">
                                                    {t(
                                                        group.kind === "recent"
                                                            ? "recentEmojiStatuses"
                                                            : group.kind === "collectible"
                                                              ? "collectibleEmojiStatuses"
                                                              : "suggestedEmojiStatuses",
                                                    )}
                                                </h3>
                                            </Show>
                                            <Show
                                                when={group.choices.length}
                                                fallback={
                                                    <p class="hint">
                                                        {t(
                                                            group.kind === "recent"
                                                                ? "emptyRecentEmojiStatuses"
                                                                : "emptyEmojiPack",
                                                        )}
                                                    </p>
                                                }
                                            >
                                                <EmojiChoices
                                                    active={artworkActive()}
                                                    choices={group.choices}
                                                    api={props.api}
                                                    selected={selected()}
                                                    busy={props.busy}
                                                    toggle={toggle}
                                                    single={props.single}
                                                />
                                            </Show>
                                        </section>
                                    )}
                                </For>
                            </Show>
                        </Show>
                        <Show when={search.query.trim()}>
                            <h2
                                id={props.single ? "photo-emoji-pack-title" : "emoji-pack-title"}
                                class="text-base"
                            >
                                {t("emojiSearchResults")}
                            </h2>
                            <Show when={search.state.choices.length}>
                                <EmojiChoices
                                    active={artworkActive()}
                                    choices={search.state.choices}
                                    api={props.api}
                                    selected={selected()}
                                    busy={props.busy}
                                    toggle={toggle}
                                    single={props.single}
                                />
                            </Show>
                            <Show when={search.state.loading}>
                                <p class="hint" role="status">
                                    {t("loadingEmoji")}
                                </p>
                            </Show>
                            <Show when={search.state.error}>
                                <p class="hint" role="status">
                                    {search.state.error}
                                </p>
                                <Button variant="secondary" size="sm" onClick={search.retry}>
                                    {t("retry")}
                                </Button>
                            </Show>
                            <Show
                                when={
                                    !search.state.loading &&
                                    !search.state.error &&
                                    search.state.nextOffset == null &&
                                    !search.state.choices.length
                                }
                            >
                                <p class="hint" role="status">
                                    {t("emojiSearchEmpty")}
                                </p>
                            </Show>
                            <Show
                                when={
                                    search.state.nextOffset != null &&
                                    !search.state.loading &&
                                    !search.state.error
                                }
                            >
                                <EmojiSearchMore loadMore={search.loadMore} />
                            </Show>
                        </Show>
                    </div>
                </div>
            </Show>
        </section>
    );
}
