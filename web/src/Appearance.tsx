import { Modal, ModalCloseFooter } from "./Modal";
import {
    createEffect,
    createMemo,
    createSignal,
    For,
    onCleanup,
    onSettled,
    Show,
    untrack,
} from "solid-js";
import type {
    AccountApi,
    Appearance,
    AppearanceCatalog,
    AppearanceValue,
    Profile,
    EmojiChoice,
    State,
} from "./api";
import { RequestError } from "./api";
import { createAutosave } from "./autosave";
import { SortableList } from "./SortableList";
import { EmojiMedia } from "./EmojiMedia";
import { Button } from "./components/ui";
import { t } from "./i18n";
import { updateAppearanceSection } from "./appearance-editor";
import { EmojiChoices } from "./EmojiPicker";
import { DefaultEmojiGlyph } from "./default-emoji";
import { profileBackground, replyAccent, swatchFill } from "./appearance-preview";

export const unchangedAppearance = (): Appearance => ({ profile: null, name: null });

export function AppearanceEditor(props: {
    api: AccountApi;
    value: Appearance;
    change: (value: Appearance) => void;
    disabled: boolean;
    profile?: Profile | null;
    avatarUrl?: string;
    catalog?: AppearanceCatalog;
}) {
    const [catalog, setCatalog] = createSignal<AppearanceCatalog>();
    const [error, setError] = createSignal("");
    async function load() {
        setError("");
        try {
            setCatalog(await props.api.request("appearance/catalog"));
        } catch (error) {
            setError(error instanceof RequestError ? error.message : t("requestFailed"));
        }
    }

    onSettled(() => {
        if (!props.catalog) void load();
    });
    function update(section: "profile" | "name", value: AppearanceValue | null) {
        props.change(updateAppearanceSection(props.value, section, value));
    }

    return (
        <div class="space-y-4">
            <Show when={error()}>
                <p role="alert">{error()}</p>
                <Button variant="secondary" onClick={() => void load()}>
                    {t("appearanceRetry")}
                </Button>
            </Show>
            <Show
                when={props.catalog ?? catalog()}
                fallback={
                    <Show when={!error()}>
                        <div role="status">
                            <span class="visually-hidden">{t("appearanceLoading")}</span>
                            <div class="space-y-4" aria-hidden="true">
                                <For each={["profile", "name"] as const}>
                                    {(section) => (
                                        <div class="space-y-3">
                                            <span class="appearance-skeleton appearance-skeleton-heading" />
                                            <Show
                                                when={
                                                    props.value[section]?.color != null ||
                                                    props.value[section]?.emoji
                                                }
                                            >
                                                <span
                                                    class={`appearance-skeleton appearance-skeleton-preview-${section}`}
                                                />
                                            </Show>
                                            <div class="flex flex-wrap gap-2">
                                                <For each={[0, 1, 2, 3, 4, 5, 6]}>
                                                    {() => (
                                                        <span class="appearance-skeleton appearance-skeleton-swatch" />
                                                    )}
                                                </For>
                                            </div>
                                            <div class="flex items-center gap-3">
                                                <span class="appearance-skeleton appearance-skeleton-label" />
                                                <span class="appearance-skeleton appearance-skeleton-icon" />
                                            </div>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </div>
                    </Show>
                }
            >
                {(data) => (
                    <For each={["profile", "name"] as const}>
                        {(section) => {
                            const value = createMemo(() => props.value[section]);
                            const [choosing, setChoosing] = createSignal(false);
                            const [packId, setPackId] = createSignal("");
                            const [choices, setChoices] = createSignal<EmojiChoice[]>(
                                data().choices,
                            );
                            const [loading, setLoading] = createSignal(false);
                            async function selectPack(id: string) {
                                if (loading()) return;
                                setPackId(id);
                                setError("");
                                if (!id) {
                                    setChoices(data().choices);
                                    return;
                                }
                                setChoices([]);
                                setLoading(true);
                                try {
                                    const result = await props.api.request(
                                        `emojis/sets/${encodeURIComponent(id)}`,
                                    );
                                    setChoices(result.choices);
                                } catch (failure) {
                                    setError(
                                        failure instanceof RequestError
                                            ? failure.message
                                            : t("requestFailed"),
                                    );
                                } finally {
                                    setLoading(false);
                                }
                            }
                            const edit = (next: AppearanceValue) => update(section, next);

                            const colors = () =>
                                section === "profile" ? data().profile_colors : data().name_colors;

                            return (
                                <fieldset
                                    disabled={props.disabled}
                                    class="m-0 min-w-0 space-y-3 border-0 p-0"
                                >
                                    <legend class="w-full font-semibold">
                                        <span class="flex items-center justify-between gap-3">
                                            <span>
                                                {t(
                                                    section === "profile"
                                                        ? "appearanceProfile"
                                                        : "appearanceName",
                                                )}
                                            </span>
                                            <Show when={value() !== null}>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    disabled={props.disabled}
                                                    onClick={() => update(section, null)}
                                                >
                                                    {t("clearPhotoEmoji")}
                                                </Button>
                                            </Show>
                                        </span>
                                    </legend>
                                    <Show when={value()?.color != null || value()?.emoji}>
                                        <AppearancePreview
                                            api={props.api}
                                            section={section}
                                            value={value()!}
                                            palette={colors().find(
                                                (color) => color.id === value()?.color,
                                            )}
                                            profile={props.profile}
                                            avatarUrl={props.avatarUrl}
                                        />
                                    </Show>
                                    <div class="space-y-3">
                                        <div class="flex flex-wrap gap-2">
                                            <For each={colors()}>
                                                {(color) => (
                                                    <button
                                                        type="button"
                                                        class="appearance-swatch"
                                                        style={{
                                                            "--swatch-light": swatchFill(
                                                                color.colors,
                                                            ),
                                                            "--swatch-dark": swatchFill(
                                                                color.dark_colors.length
                                                                    ? color.dark_colors
                                                                    : color.colors,
                                                            ),
                                                        }}
                                                        aria-label={t("appearancePalette", {
                                                            id: color.id,
                                                        })}
                                                        aria-pressed={
                                                            value()?.color === color.id
                                                                ? "true"
                                                                : "false"
                                                        }
                                                        onClick={() =>
                                                            edit({
                                                                color: color.id,
                                                                emoji: value()?.emoji ?? null,
                                                            })
                                                        }
                                                    >
                                                        <span />
                                                    </button>
                                                )}
                                            </For>
                                        </div>
                                        <div class="flex flex-wrap items-center gap-3">
                                            <span class="text-sm font-semibold">
                                                {t(
                                                    section === "profile"
                                                        ? "linkedProfileIcon"
                                                        : "linkedRepliesIcon",
                                                )}
                                            </span>
                                            <button
                                                type="button"
                                                class={
                                                    value()?.emoji
                                                        ? "size-12 flex items-center justify-center photo-icon-action rounded-lg border bg-[Canvas] p-0 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                                        : "emoji-add photo-icon-action"
                                                }
                                                aria-label={t(
                                                    section === "profile"
                                                        ? "linkedProfileIcon"
                                                        : "linkedRepliesIcon",
                                                )}
                                                aria-expanded={choosing() ? "true" : "false"}
                                                onClick={() => setChoosing(!choosing())}
                                            >
                                                <Show
                                                    when={value()?.emoji}
                                                    fallback={
                                                        <svg aria-hidden="true" viewBox="0 0 24 24">
                                                            <path d="M12 5v14M5 12h14" />
                                                        </svg>
                                                    }
                                                >
                                                    {(emoji) => (
                                                        <EmojiMedia
                                                            url={props.api.emojiMediaUrl(
                                                                emoji().document_id ?? emoji().id,
                                                            )}
                                                            label={emoji().label}
                                                            textColor={emoji().text_color}
                                                        />
                                                    )}
                                                </Show>
                                            </button>
                                        </div>
                                        <Show when={choosing()}>
                                            <div
                                                class="emoji-browser"
                                                onKeyDown={(event) => {
                                                    if (event.key === "Escape") {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        setChoosing(false);
                                                    }
                                                }}
                                            >
                                                <nav
                                                    class="emoji-packs"
                                                    aria-label={t("emojiPacks")}
                                                >
                                                    <button
                                                        type="button"
                                                        disabled={loading()}
                                                        aria-label={t("appearanceDefaultIcons")}
                                                        title={t("appearanceDefaultIcons")}
                                                        aria-pressed={
                                                            packId() === "" ? "true" : "false"
                                                        }
                                                        onClick={() => void selectPack("")}
                                                    >
                                                        <svg
                                                            class="pack-glyph"
                                                            aria-hidden="true"
                                                            viewBox="0 0 24 24"
                                                        >
                                                            <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
                                                        </svg>
                                                    </button>
                                                    <For each={data().sets}>
                                                        {(pack) => (
                                                            <button
                                                                type="button"
                                                                disabled={loading()}
                                                                title={pack.title}
                                                                aria-label={pack.title}
                                                                aria-pressed={
                                                                    packId() === pack.id
                                                                        ? "true"
                                                                        : "false"
                                                                }
                                                                onClick={() =>
                                                                    void selectPack(pack.id)
                                                                }
                                                            >
                                                                <EmojiMedia
                                                                    url={pack.cover_url}
                                                                    label={pack.title}
                                                                    textColor={pack.text_color}
                                                                />
                                                            </button>
                                                        )}
                                                    </For>
                                                </nav>
                                                <div
                                                    class="emoji-pack-choices"
                                                    aria-busy={loading() ? "true" : "false"}
                                                >
                                                    <Show when={!packId()}>
                                                        <div class="emojis">
                                                            <label
                                                                class="emoji-choice"
                                                                title={t("appearanceNoIcon")}
                                                            >
                                                                <input
                                                                    type="radio"
                                                                    aria-label={t(
                                                                        "appearanceNoIcon",
                                                                    )}
                                                                    checked={!value()?.emoji}
                                                                    disabled={
                                                                        props.disabled || loading()
                                                                    }
                                                                    onChange={() => {
                                                                        edit({
                                                                            color:
                                                                                value()?.color ??
                                                                                null,
                                                                            emoji: null,
                                                                        });
                                                                        setChoosing(false);
                                                                    }}
                                                                />
                                                                <DefaultEmojiGlyph />
                                                            </label>
                                                        </div>
                                                    </Show>
                                                    <Show when={loading()}>
                                                        <p role="status">{t("loadingEmoji")}</p>
                                                    </Show>
                                                    <EmojiChoices
                                                        active
                                                        choices={choices()}
                                                        api={props.api}
                                                        selected={
                                                            value()?.emoji
                                                                ? [value()!.emoji!.id]
                                                                : []
                                                        }
                                                        busy={props.disabled || loading()}
                                                        single
                                                        toggle={(id) => {
                                                            const emoji = choices().find(
                                                                (choice) => choice.id === id,
                                                            );
                                                            if (emoji) {
                                                                edit({
                                                                    color: value()?.color ?? null,
                                                                    emoji,
                                                                });
                                                                setChoosing(false);
                                                            }
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        </Show>
                                    </div>
                                </fieldset>
                            );
                        }}
                    </For>
                )}
            </Show>
        </div>
    );
}

function AppearancePreview(props: {
    api: AccountApi;
    section: "profile" | "name";
    value: AppearanceValue;
    palette?: import("./api").AppearanceColor;
    profile?: Profile | null;
    avatarUrl?: string;
}) {
    const name = () => props.profile?.name || t("appearancePreviewName");
    const url = () => props.avatarUrl || props.profile?.photo_url;

    const light = () => props.palette?.colors ?? [];
    const dark = () => (props.palette?.dark_colors.length ? props.palette.dark_colors : light());
    const hex = (colors: number[]) =>
        colors.length ? `#${colors[0].toString(16).padStart(6, "0")}` : undefined;

    return (
        <div
            class={`appearance-preview appearance-preview-${props.section}`}
            role="img"
            aria-label={t("appearancePreview")}
            style={{
                "--preview-light": profileBackground(props.palette?.bg_colors ?? []),
                "--preview-dark": profileBackground(
                    props.palette?.dark_bg_colors?.length
                        ? props.palette.dark_bg_colors
                        : (props.palette?.bg_colors ?? []),
                ),
                "--preview-ink-light": hex(light()),
                "--preview-ink-dark": hex(dark()),
                "--preview-reply-light": replyAccent(light()),
                "--preview-reply-dark": replyAccent(dark()),
            }}
        >
            <Show
                when={props.section === "profile"}
                fallback={
                    <div class="appearance-preview-message">
                        <strong title={name()}>{name()}</strong>
                        <blockquote>
                            <AppearancePattern api={props.api} emoji={props.value.emoji} reply />
                            <strong>{name()}</strong>
                            <span>{t("appearancePreviewReply")}</span>
                        </blockquote>
                        <span>{t("appearancePreviewMessage")}</span>
                    </div>
                }
            >
                <AppearancePattern api={props.api} emoji={props.value.emoji} />
                <div class="appearance-preview-avatar" aria-hidden="true">
                    <span>{name().slice(0, 1).toLocaleUpperCase()}</span>
                    <Show when={url()}>
                        {(src) => (
                            <img
                                src={src()}
                                alt=""
                                draggable={false}
                                onError={(event) => {
                                    event.currentTarget.style.display = "none";
                                }}
                            />
                        )}
                    </Show>
                </div>
                <strong class="appearance-preview-title" title={name()}>
                    {name()}
                </strong>
                <span class="appearance-preview-status">{t("appearancePreviewStatus")}</span>
            </Show>
        </div>
    );
}

function AppearancePattern(props: { api: AccountApi; emoji: EmojiChoice | null; reply?: boolean }) {
    return (
        <Show when={props.emoji}>
            {(emoji) => (
                <div
                    class={[
                        "appearance-preview-pattern",
                        { "appearance-preview-reply-pattern": props.reply },
                    ]}
                    aria-hidden="true"
                >
                    <For each={Array.from({ length: props.reply ? 6 : 12 })}>
                        {() => (
                            <EmojiMedia
                                url={props.api.emojiMediaUrl(emoji().document_id ?? emoji().id)}
                                label=""
                                textColor={emoji().text_color}
                            />
                        )}
                    </For>
                </div>
            )}
        </Show>
    );
}

export function AppearancePanel(props: {
    api: AccountApi;
    state: State;
    premium: boolean;
    busy: boolean;
    refresh: () => Promise<void>;
    reportSave: (status: "idle" | "pending" | "saved" | "error", retry: () => void) => void;
    children: (dirty: () => boolean) => import("@solidjs/web").JSX.Element;
}) {
    let nextId = 0;
    const [entries, setEntries] = createSignal(
        untrack(() =>
            props.state.appearance_presets.map((value) => ({ id: String(nextId++), value })),
        ),
    );
    const [editing, setEditing] = createSignal<string>();

    const autosave = createAutosave<Appearance[]>(
        (presets) => props.api.request("appearance/presets", "PUT", { presets }),
        () => props.refresh(),
    );
    function update(next: ReturnType<typeof entries>) {
        setEntries(next);
        autosave.edit(next.map((entry) => entry.value));
    }
    const dirty = () => autosave.status() === "pending" || autosave.status() === "error";
    createEffect(autosave.status, (status) =>
        props.reportSave(status, () => void autosave.retry().catch(() => {})),
    );
    createEffect(
        () => [autosave.status(), autosave.draft(), props.state.appearance_presets] as const,
        ([status, draft, server]) => {
            if (status === "saved" && draft && JSON.stringify(draft) === JSON.stringify(server))
                autosave.acknowledge();
            if (!autosave.draft()) {
                setEntries((current) =>
                    server.map((value, index) => ({
                        id: current[index]?.id ?? String(nextId++),
                        value,
                    })),
                );
            }
        },
    );
    onCleanup(autosave.dispose);
    onCleanup(() => props.reportSave("idle", () => {}));

    const [catalog, setCatalog] = createSignal<AppearanceCatalog>();
    const [error, setError] = createSignal("");
    async function loadCatalog() {
        setError("");
        try {
            setCatalog(await props.api.request("appearance/catalog"));
        } catch (error) {
            setError(error instanceof RequestError ? error.message : t("requestFailed"));
        }
    }
    onSettled(() => void loadCatalog());

    return (
        <section
            aria-label={t("appearance")}
            class="space-y-4"
            aria-busy={props.busy ? "true" : "false"}
        >
            <Show when={props.busy}>
                <p role="status">{t("savingChanges")}</p>
            </Show>
            <Show when={props.state.profile?.appearance_collectible_conflict}>
                <p role="status">{t("appearanceCurrentConflict")}</p>
            </Show>
            <Show when={!props.premium}>
                <p role="status">{t("appearancePremium")}</p>
            </Show>
            <Show when={error()}>
                <p role="alert">{error()}</p>
                <Button variant="secondary" onClick={() => void loadCatalog()}>
                    {t("appearanceRetry")}
                </Button>
            </Show>
            <Show when={!catalog() && !error()}>
                <p role="status">{t("appearanceLoading")}</p>
            </Show>
            <Show when={!entries().length}>
                <p>{t("appearanceEmpty")}</p>
            </Show>
            <SortableList
                kind="appearance"
                busy={!props.premium || props.busy || !catalog()}
                items={entries().map((entry, index) => ({
                    id: entry.id,
                    label: t("appearancePreset", { number: index + 1 }),
                    reorderLabel: t("reorderAppearance", { number: index + 1 }),
                    editLabel: t("appearanceEdit", { number: index + 1 }),
                    removeLabel: t("appearanceRemove", { number: index + 1 }),
                }))}
                reorder={(ids) =>
                    update(ids.map((id) => entries().find((entry) => entry.id === id)!))
                }
                remove={(id) => update(entries().filter((entry) => entry.id !== id))}
                edit={(id) => setEditing(id)}
                preview={(id) => setEditing(id)}
                renderPreview={(id) => {
                    const preset = () => entries().find((entry) => entry.id === id)!.value;
                    return (
                        <span class="appearance-preset-select">
                            <For each={["profile", "name"] as const}>
                                {(section) => (
                                    <AppearancePreview
                                        api={props.api}
                                        section={section}
                                        value={preset()[section] ?? { color: null, emoji: null }}
                                        palette={(section === "profile"
                                            ? catalog()?.profile_colors
                                            : catalog()?.name_colors
                                        )?.find((color) => color.id === preset()[section]?.color)}
                                        profile={props.state.profile}
                                    />
                                )}
                            </For>
                        </span>
                    );
                }}
                trailing={
                    <button
                        type="button"
                        class="appearance-preset-add"
                        disabled={!props.premium || props.busy || !catalog()}
                        onClick={() => {
                            const id = String(nextId++);
                            update([
                                ...entries(),
                                {
                                    id,
                                    value: structuredClone(
                                        props.state.profile?.appearance ?? unchangedAppearance(),
                                    ),
                                },
                            ]);
                            setEditing(id);
                        }}
                    >
                        <span aria-hidden="true">+</span>
                        {t("appearanceAdd")}
                    </button>
                }
            />
            <Show when={editing()}>
                {(id) => (
                    <AppearancePresetDialog
                        api={props.api}
                        catalog={catalog()!}
                        value={entries().find((entry) => entry.id === id())!.value}
                        profile={props.state.profile}
                        disabled={!props.premium || props.busy}
                        title={t("appearanceEdit", {
                            number: entries().findIndex((entry) => entry.id === id()) + 1,
                        })}
                        close={() => setEditing(undefined)}
                        change={(value) =>
                            update(
                                entries().map((entry) =>
                                    entry.id === id() ? { ...entry, value } : entry,
                                ),
                            )
                        }
                    />
                )}
            </Show>
            {props.children(dirty)}
        </section>
    );
}

function AppearancePresetDialog(props: {
    api: AccountApi;
    catalog: AppearanceCatalog;
    value: Appearance;
    profile?: Profile | null;
    disabled: boolean;
    title: string;
    close: () => void;
    change: (value: Appearance) => void;
}) {
    return (
        <Modal label={props.title} onDismiss={props.close}>
            <div class="space-y-4">
                <AppearanceEditor
                    api={props.api}
                    catalog={props.catalog}
                    value={props.value}
                    change={props.change}
                    disabled={props.disabled}
                    profile={props.profile}
                />
                <ModalCloseFooter onDismiss={props.close} />
            </div>
        </Modal>
    );
}
