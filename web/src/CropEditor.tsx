import { createSignal, onCleanup, onSettled, Show, untrack } from "solid-js";
import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";
import type { AccountApi, Crop, Photo } from "./api";
import { RequestError } from "./api";
import { Button } from "./components/ui";
import { centeredCrop, cropFromPixels, cropToPixels } from "./crop";
import { t } from "./i18n";

export function CropEditor(props: {
    api: AccountApi;
    photo: Photo;
    refresh: () => Promise<void>;
    close: () => void;
    saving: boolean;
    setSaving: (value: boolean) => void;
}) {
    let image!: HTMLImageElement;
    let cropper: Cropper | undefined;
    let resetting = false;
    // Seed the editing draft once; server refreshes must not overwrite an in-progress crop.
    const [crop, setCrop] = createSignal<Crop | null>(untrack(() => props.photo.crop));
    const [dimensions, setDimensions] = createSignal({ width: 1, height: 1 });
    const [ready, setReady] = createSignal(false);
    const [error, setError] = createSignal("");

    function apply(value: Crop | null, imageDimensions = dimensions()) {
        resetting = true;
        cropper?.setData(cropToPixels(value ?? centeredCrop(imageDimensions), imageDimensions));
        resetting = false;
        setCrop(value);
    }
    async function save() {
        props.setSaving(true);
        cropper?.disable();
        setError("");
        try {
            await props.api.saveCrop(props.photo.id, crop());
            await props.refresh();
            props.close();
        } catch (failure) {
            setError(failure instanceof RequestError ? failure.message : t("cropSaveError"));
        } finally {
            cropper?.enable();
            props.setSaving(false);
        }
    }
    onSettled(() => {
        cropper = new Cropper(image, {
            aspectRatio: 1,
            viewMode: 1,
            autoCropArea: 1,
            responsive: true,
            background: false,
            modal: false,
            ready() {
                const data = cropper!.getCanvasData();
                const imageDimensions = { width: data.naturalWidth, height: data.naturalHeight };
                setDimensions(imageDimensions);
                apply(props.photo.crop, imageDimensions);
                setReady(true);
            },
            crop(event) {
                if (!ready() || resetting) return;
                setCrop(cropFromPixels(event.detail, dimensions()));
            },
        });
    });
    onCleanup(() => cropper?.destroy());

    return (
        <>
            <div class="crop-stage" aria-busy={!ready() && !error() ? "true" : "false"}>
                <img
                    ref={(element) => {
                        image = element;
                    }}
                    src={props.api.originalPhotoUrl(props.photo.id)}
                    alt=""
                    onError={() => setError(t("cropLoadError"))}
                />
                <Show when={!ready() && !error()}>
                    <span class="photo-dialog-skeleton" role="status">
                        <span class="visually-hidden">{t("cropLoading")}</span>
                    </span>
                </Show>
            </div>
            <Show when={error()}>
                <p class="text-danger" role="alert">
                    {error()}
                </p>
            </Show>
            <div class="mt-4 flex flex-wrap justify-end gap-2">
                <Button
                    class="me-auto"
                    variant="ghost"
                    disabled={!ready() || props.saving}
                    onClick={() => apply(null)}
                >
                    {t("cropReset")}
                </Button>
                <Button variant="secondary" disabled={props.saving} onClick={() => props.close()}>
                    {t("cancel")}
                </Button>
                <Button disabled={!ready() || props.saving} onClick={() => void save()}>
                    {props.saving ? t("savingChanges") : t("cropSave")}
                </Button>
            </div>
        </>
    );
}
