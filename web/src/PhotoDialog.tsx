import { photoDisplayName } from "./display-names";
import { createSignal, onSettled, Show, untrack } from "solid-js";
import type { AccountApi, Photo } from "./api";
import { CropEditor } from "./CropEditor";
import { centeredCrop } from "./crop";
import { t } from "./i18n";

export function PhotoDialog(props: {
    api: AccountApi;
    photo: Photo;
    refresh: () => Promise<void>;
    close: () => void;
    edit: boolean;
}) {
    let dialog!: HTMLDialogElement;
    // The keyed dialog seeds its mode once, then the user controls preview versus editing.
    const [editing, setEditing] = createSignal(untrack(() => props.edit));
    const [saving, setSaving] = createSignal(false);
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
            aria-label={t("cropTitle")}
            onCancel={(event) => {
                event.preventDefault();
                if (!saving()) props.close();
            }}
            onPointerDown={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                if (
                    !saving() &&
                    (event.clientX < bounds.left ||
                        event.clientX > bounds.right ||
                        event.clientY < bounds.top ||
                        event.clientY > bounds.bottom)
                )
                    props.close();
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
                                    class="sortable-edit photo-preview-edit shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[Highlight]"
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
                    close={props.close}
                    saving={saving()}
                    setSaving={setSaving}
                />
            </Show>
        </dialog>
    );
}
