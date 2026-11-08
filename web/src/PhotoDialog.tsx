import { createPhotoAppearance } from "./photo-appearance";
import { AppearanceEditor } from "./Appearance";
import type { State } from "./api";
import { photoDisplayName } from "./display-names";
import { createSignal, Show, untrack } from "solid-js";
import type { AccountApi, Photo } from "./api";
import { CropEditor } from "./CropEditor";
import { centeredCrop } from "./crop";
import { EmojiPicker } from "./EmojiPicker";
import { EmojiMedia } from "./EmojiMedia";
import { RequestError } from "./api";
import { Button } from "./components/ui";
import { t } from "./i18n";
import { Modal, ModalCloseFooter } from "./Modal";

export function PhotoDialog(props: {
    api: AccountApi;
    photo: Photo;
    profile: State["profile"];
    refresh: () => Promise<void>;
    close: () => void;
    premium: boolean;
    chooseEmoji?: boolean;
}) {
    let dialog!: HTMLDialogElement;
    let chooseButton!: HTMLButtonElement;
    let closeButton!: HTMLButtonElement;
    function closeStatusPicker() {
        setChoosing(false);
        const target = props.premium ? chooseButton : closeButton;
        queueMicrotask(() => target.focus());
    }
    const { api, photoId, refresh } = untrack(() => ({
        api: props.api,
        photoId: props.photo.id,
        refresh: props.refresh,
    }));
    const appearance = createPhotoAppearance(
        () => props.photo.appearance,
        (value) => api.request(`photos/${encodeURIComponent(photoId)}/appearance`, "PUT", value),
        refresh,
    );
    const [editing, setEditing] = createSignal(false);
    const [saving, setSaving] = createSignal(false);
    const [choosing, setChoosing] = createSignal(untrack(() => !!props.chooseEmoji));
    const [statusError, setStatusError] = createSignal("");
    async function saveStatus(id: string | null) {
        if (saving()) return;
        setSaving(true);
        setStatusError("");
        try {
            await props.api.savePhotoEmoji(props.photo.id, id);
            await props.refresh();
            closeStatusPicker();
        } catch (failure) {
            setStatusError(failure instanceof RequestError ? failure.message : t("requestFailed"));
        } finally {
            setSaving(false);
        }
    }
    const [loaded, setLoaded] = createSignal(false);
    const [error, setError] = createSignal(false);
    const [dimensions, setDimensions] = createSignal({ width: 1, height: 1 });
    const imageStyle = () => {
        const { width, height } = dimensions();
        const crop = props.photo.crop ?? centeredCrop({ width, height });
        const size = crop.size * Math.min(width, height);
        return {
            width: `${(width / size) * 100}%`,
            height: `${(height / size) * 100}%`,
            left: `${((-crop.x * width) / size) * 100}%`,
            top: `${((-crop.y * height) / size) * 100}%`,
        };
    };
    function dismiss() {
        if (saving()) return;
        if (editing()) setEditing(false);
        else props.close();
    }

    return (
        <Modal
            label={t("photoSettings")}
            ref={(element) => {
                dialog = element;
            }}
            onDismiss={dismiss}
        >
            <Show
                when={editing()}
                fallback={
                    <>
                        <div
                            class="crop-stage photo-preview"
                            aria-busy={!loaded() && !error() ? "true" : "false"}
                        >
                            <div class="photo-preview-crop">
                                <img
                                    src={props.api.originalPhotoUrl(props.photo.id)}
                                    alt={photoDisplayName(props.photo)}
                                    style={imageStyle()}
                                    onLoad={(event) => {
                                        setDimensions({
                                            width: event.currentTarget.naturalWidth,
                                            height: event.currentTarget.naturalHeight,
                                        });
                                        setLoaded(true);
                                    }}
                                    onError={() => setError(true)}
                                />
                            </div>
                            <Show when={!loaded() && !error()}>
                                <span class="photo-dialog-skeleton" role="status">
                                    <span class="visually-hidden">{t("cropLoading")}</span>
                                </span>
                            </Show>
                            <Show when={error()}>
                                <p role="alert">{t("cropLoadError")}</p>
                            </Show>
                            <Show when={loaded() && !error()}>
                                <button
                                    type="button"
                                    class="sortable-edit photo-preview-edit photo-icon-action shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                    aria-label={t("cropPhoto", {
                                        name: photoDisplayName(props.photo),
                                    })}
                                    disabled={saving()}
                                    onClick={() => setEditing(true)}
                                >
                                    <svg aria-hidden="true" viewBox="0 0 24 24">
                                        <path d="M6 3v12a3 3 0 0 0 3 3h12M3 6h12a3 3 0 0 1 3 3v12" />
                                    </svg>
                                </button>
                            </Show>
                        </div>
                    </>
                }
            >
                <CropEditor
                    api={props.api}
                    photo={props.photo}
                    refresh={props.refresh}
                    close={() => setEditing(false)}
                    saving={saving()}
                    setSaving={setSaving}
                />
            </Show>
            <Show when={!editing()}>
                <div class="mt-5 flex flex-col gap-4">
                    <section class="m-0" aria-label={t("linkedEmoji")}>
                        <div
                            class="flex flex-wrap items-center gap-3"
                            aria-busy={saving() ? "true" : "false"}
                        >
                            <span class="text-sm font-semibold">{t("linkedEmoji")}</span>
                            <button
                                type="button"
                                class={
                                    props.photo.emoji_status
                                        ? "size-12 flex items-center justify-center photo-icon-action rounded-lg border bg-[Canvas] p-0 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
                                        : "emoji-add photo-icon-action"
                                }
                                disabled={saving() || !props.premium}
                                aria-expanded={choosing() ? "true" : "false"}
                                aria-controls="photo-emoji-browser"
                                aria-label={
                                    props.photo.emoji_status
                                        ? t("changeLinkedEmoji")
                                        : t("chooseLinkedEmoji")
                                }
                                ref={(element) => {
                                    chooseButton = element;
                                }}
                                onClick={() =>
                                    choosing() ? closeStatusPicker() : setChoosing(true)
                                }
                            >
                                <Show
                                    when={props.photo.emoji_status}
                                    fallback={
                                        <svg aria-hidden="true" viewBox="0 0 24 24">
                                            <path d="M12 5v14M5 12h14" />
                                        </svg>
                                    }
                                >
                                    {(choice) => (
                                        <EmojiMedia
                                            url={props.api.emojiMediaUrl(
                                                choice().document_id ?? choice().id,
                                            )}
                                            label={choice().label}
                                            textColor={choice().text_color}
                                        />
                                    )}
                                </Show>
                            </button>
                        </div>
                        <Show when={!props.premium}>
                            <p class="mt-3 text-sm text-muted-foreground">
                                {t("photoEmojiPremiumRequired")}
                            </p>
                        </Show>
                        <Show when={statusError()}>
                            <p class="text-sm text-danger" role="alert">
                                {statusError()}
                            </p>
                        </Show>
                        <Show when={choosing() && props.premium}>
                            <div
                                ref={(element) => {
                                    queueMicrotask(() => {
                                        dialog.scrollTo({
                                            top:
                                                dialog.scrollTop +
                                                element.getBoundingClientRect().top -
                                                dialog.getBoundingClientRect().top -
                                                20,
                                            behavior: "instant",
                                        });
                                    });
                                }}
                            >
                                <EmojiPicker
                                    single
                                    active
                                    api={props.api}
                                    busy={saving()}
                                    premium={props.premium}
                                    selected={
                                        props.photo.emoji_status
                                            ? [props.photo.emoji_status.id]
                                            : []
                                    }
                                    selectedEmojis={
                                        props.photo.emoji_status ? [props.photo.emoji_status] : []
                                    }
                                    notify={setStatusError}
                                    choose={(id) => void saveStatus(id)}
                                    dismiss={closeStatusPicker}
                                />
                            </div>
                        </Show>
                    </section>
                </div>
                <Show when={props.premium}>
                    <AppearanceEditor
                        profile={props.profile}
                        api={props.api}
                        avatarUrl={props.api.selectedPhotoUrl(props.photo)}
                        value={appearance.value()}
                        change={appearance.edit}
                        disabled={saving()}
                    />
                </Show>
                <Show when={appearance.status() === "error"}>
                    <p class="text-sm text-danger" role="alert">
                        {t("requestFailed")}
                    </p>
                    <Button
                        variant="secondary"
                        onClick={() => void appearance.retry().catch(() => {})}
                    >
                        {t("appearanceRetry")}
                    </Button>
                </Show>
                <div class="mt-4">
                    <ModalCloseFooter
                        disabled={saving()}
                        ref={(element) => {
                            closeButton = element;
                        }}
                        onDismiss={props.close}
                    />
                </div>
            </Show>
        </Modal>
    );
}
