import { createMemo, createSignal, For, Show, untrack } from "solid-js";
import { reconcilePhotoOrder, RequestError, type State } from "./api";
import type { AccountActions } from "./Accounts";
import { createAutosave } from "./autosave";
import { photoDisplayName } from "./display-names";
import { resetTilt, tilt } from "./tilt";
import { PhotoDialog } from "./PhotoDialog";
import { photoMatchMessage } from "./photo-status";
import { SortableList } from "./SortableList";
import { t } from "./i18n";
import { Button } from "./components/ui";

type Notify = (message: string, action?: () => void) => void;

export function Photos(
    props: AccountActions & {
        premium: boolean;
        notify: Notify;
        photos: State["photos"];
        profile: State["profile"];
        photoCache: State["photo_cache"];
        currentPhotoId: string | null;
        refresh: () => Promise<void>;
        autosave: ReturnType<typeof createAutosave<string[]>>;
    },
) {
    const photos = createMemo(() => {
        const ids = props.autosave.draft();
        if (!ids) return props.photos;
        const byId = new Map(props.photos.map((photo) => [photo.id, photo]));
        return reconcilePhotoOrder(
            ids,
            props.photos.map((photo) => photo.id),
        ).map((id) => byId.get(id)!);
    });
    let input!: HTMLInputElement;
    // Only the initial empty library opens the picker; later updates preserve the user’s choice.
    const [pickerOpen, setPickerOpen] = createSignal(untrack(() => props.photos.length === 0));
    const [draggingFiles, setDraggingFiles] = createSignal(false);
    const [selecting, setSelecting] = createSignal(false);
    const [uploading, setUploading] = createSignal(false);
    const [photoDialog, setPhotoDialog] = createSignal<{ id: string; chooseEmoji: boolean }>();
    let editButton: HTMLButtonElement | undefined;
    const [refreshingHistory, setRefreshingHistory] = createSignal(false);
    let pickerSummary!: HTMLElement;

    async function refreshHistory() {
        setRefreshingHistory(true);
        try {
            await props.api.request("photos/history/refresh", "POST");
            await props.refresh();
        } catch (failure) {
            props.notify(failure instanceof RequestError ? failure.message : t("cannotLoadPhotos"));
        } finally {
            setRefreshingHistory(false);
        }
    }

    function closePicker() {
        setPickerOpen(false);
        pickerSummary.focus();
    }

    async function togglePhoto(id: string) {
        if (props.busy || selecting()) return;
        const selected = props.photos.find((photo) => photo.telegram_id === id);
        setSelecting(true);
        try {
            // oxlint-disable-next-line solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation.
            await props.perform(async () => {
                await props.autosave.flush();
                await (selected
                    ? props.api.request(`photos/${encodeURIComponent(selected.id)}`, "DELETE")
                    : props.api.request("photos/history", "POST", { id }));
            });
        } finally {
            setSelecting(false);
        }
    }

    async function upload(files: File[]) {
        if (!files.length || props.busy) return;
        setUploading(true);
        try {
            // oxlint-disable-next-line solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation.
            await props.perform(async () => {
                await props.autosave.flush();
                for (const file of files) {
                    const form = new FormData();
                    form.append("file", file);
                    await props.api.request("photos", "POST", form);
                }
            });
        } finally {
            setUploading(false);
        }
    }

    function reorder(ids: string[]) {
        props.autosave.edit(ids);
    }

    function remove(id: string) {
        // oxlint-disable-next-line solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation.
        void props.perform(async () => {
            await props.autosave.flush();
            await props.api.request(`photos/${encodeURIComponent(id)}`, "DELETE");
        });
    }

    function reupload(id: string) {
        // oxlint-disable-next-line solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation.
        void props.perform(async () => {
            await props.autosave.flush();
            await props.api.reuploadPhoto(id);
        });
    }

    function openPhoto(id: string, button: HTMLButtonElement, chooseEmoji = false) {
        editButton = button;
        setPhotoDialog({ id, chooseEmoji });
    }

    return (
        <section
            aria-label={t("profilePhotos")}
            class={{ "photo-drop-active": draggingFiles() }}
            onDragOver={(event) => {
                if (!event.dataTransfer?.types.includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = props.busy ? "none" : "copy";
                setDraggingFiles(!props.busy);
            }}
            onDragLeave={(event) => {
                if (
                    !(event.relatedTarget instanceof Node) ||
                    !event.currentTarget.contains(event.relatedTarget)
                )
                    setDraggingFiles(false);
            }}
            onDrop={(event) => {
                if (!event.dataTransfer?.types.includes("Files")) return;
                event.preventDefault();
                setDraggingFiles(false);
                void upload(Array.from(event.dataTransfer.files));
            }}
        >
            <input
                type="file"
                accept="image/jpeg,image/png"
                multiple
                disabled={props.busy}
                class="visually-hidden"
                aria-label={t("uploadPhotos")}
                tabindex="-1"
                ref={(element) => {
                    input = element;
                }}
                onChange={(event) => {
                    if (event.currentTarget.files)
                        void upload(Array.from(event.currentTarget.files));
                    event.currentTarget.value = "";
                }}
            />
            <Show when={uploading()}>
                <p role="status">{t("savingPhotos")}</p>
            </Show>
            <SortableList
                kind="photo"
                busy={props.busy}
                reorder={reorder}
                items={photos().map((photo, index) => {
                    const badge = photoMatchMessage(photo, props.photoCache);
                    return {
                        id: photo.id,
                        label: photoDisplayName(photo),
                        imageUrl: props.api.selectedPhotoUrl(photo),
                        reorderLabel: photo.generated_name ? t("reorderTelegramPhoto") : undefined,
                        removeLabel: photo.generated_name ? t("removeTelegramPhoto") : undefined,
                        badge,
                        badgeActionLabel:
                            badge === "photoUnavailable" &&
                            props.photoCache.recovery[photo.id]?.can_upload
                                ? t("photoUploadAgainAt", { number: index + 1 })
                                : undefined,
                        statusUrl: photo.emoji_status
                            ? props.api.emojiMediaUrl(
                                  photo.emoji_status.document_id ?? photo.emoji_status.id,
                              )
                            : undefined,
                        statusLabel: photo.emoji_status?.label,
                        statusTextColor: photo.emoji_status?.text_color,
                        current: photo.id === props.currentPhotoId,
                    };
                })}
                recover={reupload}
                edit={openPhoto}
                editStatus={(id, button) => openPhoto(id, button, true)}
                preview={openPhoto}
                remove={remove}
                trailing={
                    <button
                        type="button"
                        class="photo-add"
                        disabled={props.busy}
                        aria-label={t("uploadPhotos")}
                        title={t("uploadPhotos")}
                        onClick={() => input.click()}
                    >
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                    </button>
                }
            />
            <Show when={photoDialog()} keyed>
                {(selection) => (
                    <Show when={props.photos.find((photo) => photo.id === selection.id)}>
                        {(photo) => (
                            <PhotoDialog
                                profile={props.profile}
                                chooseEmoji={selection.chooseEmoji}
                                premium={props.premium}
                                api={props.api}
                                photo={photo()}
                                refresh={props.refresh}
                                close={() => {
                                    setPhotoDialog(undefined);
                                    queueMicrotask(() => editButton?.focus());
                                }}
                            />
                        )}
                    </Show>
                )}
            </Show>
            <div
                id="photo-browser"
                class="photo-browser"
                onKeyDown={(event) => {
                    if (event.key === "Escape" && pickerOpen()) {
                        event.preventDefault();
                        closePicker();
                    }
                }}
            >
                <div class="flex items-center gap-2">
                    <details
                        open={pickerOpen()}
                        onToggle={(event) => setPickerOpen(event.currentTarget.open)}
                    >
                        <summary
                            aria-controls="photo-history"
                            ref={(element) => {
                                pickerSummary = element;
                            }}
                        >
                            {t("selectExistingPhotos")}
                        </summary>
                    </details>
                    <Button
                        variant="ghost"
                        size="icon"
                        class="size-8 min-h-8"
                        aria-label={t("refreshPhotoCache")}
                        title={t("refreshPhotoCache")}
                        disabled={refreshingHistory() || props.photoCache.status === "refreshing"}
                        onClick={() => void refreshHistory()}
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
                </div>
                <Show when={pickerOpen()}>
                    <div
                        id="photo-history"
                        class="photo-history"
                        role="region"
                        aria-label={t("telegramProfilePhotos")}
                        aria-busy={props.photoCache.status === "refreshing" ? "true" : "false"}
                    >
                        <Show when={props.photoCache.status !== "ready"}>
                            <p class="hint" role="status">
                                {t(
                                    props.photoCache.status === "refreshing"
                                        ? "photoCacheRefreshing"
                                        : "photoCacheError",
                                )}
                            </p>
                        </Show>
                        <Show
                            when={props.photoCache.photos.length}
                            fallback={
                                <Show when={props.photoCache.status === "ready"}>
                                    <p class="hint">{t("noTelegramPhotos")}</p>
                                </Show>
                            }
                        >
                            <div class="photo-choices">
                                <For each={props.photoCache.photos.map((photo) => photo.id)}>
                                    {(id, index) => (
                                        <PhotoChoice
                                            url={props.api.photoHistoryUrl(id)}
                                            label={t("includeTelegramPhoto", {
                                                number: index() + 1,
                                            })}
                                            checked={props.photos.some(
                                                (item) => item.telegram_id === id,
                                            )}
                                            disabled={props.busy || selecting()}
                                            toggle={() => void togglePhoto(id)}
                                        />
                                    )}
                                </For>
                            </div>
                        </Show>
                    </div>
                    <p class="hint">{t("photoSelectionHint")}</p>
                </Show>
            </div>
        </section>
    );
}

function PhotoChoice(props: {
    url: string;
    label: string;
    checked: boolean;
    disabled: boolean;
    toggle: () => void;
}) {
    const [loading, setLoading] = createSignal(true);

    return (
        <label
            class="photo-choice"
            onPointerMove={tilt}
            onPointerLeave={resetTilt}
            onPointerCancel={resetTilt}
        >
            <input
                class="visually-hidden"
                type="checkbox"
                aria-label={props.label}
                checked={props.checked}
                disabled={props.disabled}
                onChange={(event) => {
                    event.currentTarget.checked = props.checked;
                    props.toggle();
                }}
            />
            <Show when={loading()}>
                <span class="photo-skeleton" aria-hidden="true" />
            </Show>
            <img
                class={{ "photo-loading": loading() }}
                src={props.url}
                alt=""
                loading="lazy"
                draggable="false"
                onLoad={() => setLoading(false)}
                onError={() => setLoading(false)}
            />
        </label>
    );
}
