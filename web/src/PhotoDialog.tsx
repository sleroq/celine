import { photoDisplayName } from "./display-names";
import { createSignal, onSettled, Show, untrack } from "solid-js";
import type { AccountApi, Photo } from "./api";
import { CropEditor } from "./CropEditor";
import { centeredCrop } from "./crop";
import { EmojiPicker } from "./EmojiPicker";
import { EmojiMedia } from "./EmojiMedia";
import { RequestError } from "./api";
import { Button } from "./components/ui";
import { t } from "./i18n";

export function PhotoDialog(props: {
    api: AccountApi;
    photo: Photo;
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
    onSettled(() => dialog.showModal());

    return (
        <dialog
            class="w-[min(36rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-auto rounded-xl border-0 bg-surface p-5 text-foreground shadow-xl backdrop:bg-black/65"
            ref={(element) => {
                dialog = element;
            }}
            aria-label={t("photoSettings")}
            onCancel={(event) => {
                event.preventDefault();
                if (!saving()) {
                    if (editing()) setEditing(false);
                    else props.close();
                }
            }}
            onPointerDown={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                if (
                    !saving() &&
                    (event.clientX < bounds.left ||
                        event.clientX > bounds.right ||
                        event.clientY < bounds.top ||
                        event.clientY > bounds.bottom)
                ) {
                    if (editing()) setEditing(false);
                    else props.close();
                }
            }}
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
                            <Show when={props.photo.emoji_status}>
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
                            <div class="ms-auto flex gap-2">
                                <Show when={props.photo.emoji_status}>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={saving()}
                                        aria-label={t("clearLinkedEmoji")}
                                        onClick={() => void saveStatus(null)}
                                    >
                                        {t("clearPhotoEmoji")}
                                    </Button>
                                </Show>
                                <Show when={props.premium}>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={saving()}
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
                                        {props.photo.emoji_status
                                            ? t("changePhotoEmoji")
                                            : t("choosePhotoEmoji")}
                                    </Button>
                                </Show>
                            </div>
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
                <div class="mt-4 flex justify-end">
                    <Button
                        variant="ghost"
                        disabled={saving()}
                        ref={(element) => {
                            closeButton = element;
                        }}
                        onClick={props.close}
                    >
                        {t("closePhotoSettings")}
                    </Button>
                </div>
            </Show>
        </dialog>
    );
}
