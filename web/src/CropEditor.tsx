import { createSignal, onCleanup, onSettled, Show, untrack } from "solid-js";
import Cropper from "cropperjs";
import type { AccountApi, Crop, Photo } from "./api";
import { RequestError } from "./api";
import { Button } from "./components/ui";
import { centeredCrop, cropFromPixels, cropToPixels, type CropPixels } from "./crop";
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
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    // Seed the editing draft once; server refreshes must not overwrite an in-progress crop.
    const [crop, setCrop] = createSignal<Crop | null>(untrack(() => props.photo.crop));
    let dimensions = { width: 1, height: 1 };
    const [ready, setReady] = createSignal(false);
    const [error, setError] = createSignal("");

    function apply(value: Crop | null) {
        const canvas = cropper!.getCropperCanvas()!;
        const image = cropper!.getCropperImage()!;
        if (value === null) {
            resetting = true;
            image.$center("contain");
            resetting = false;
        }
        const selection = cropper!.getCropperSelection()!;
        const canvasRect = canvas.getBoundingClientRect();
        const imageRect = image.$image.getBoundingClientRect();
        const pixels = cropToPixels(value ?? centeredCrop(dimensions), dimensions);
        const scale = imageRect.width / dimensions.width;
        resetting = true;
        selection.$change(
            imageRect.left - canvasRect.left + pixels.x * scale,
            imageRect.top - canvasRect.top + pixels.y * scale,
            pixels.width * scale,
            pixels.height * scale,
        );
        resetting = false;
        setCrop(value);
    }
    function normalized(selection: CropPixels, imageRect: CropPixels) {
        const scale = dimensions.width / imageRect.width;
        return cropFromPixels(
            {
                x: (selection.x - imageRect.x) * scale,
                y: (selection.y - imageRect.y) * scale,
                width: selection.width * scale,
                height: selection.height * scale,
            },
            dimensions,
        );
    }
    function contains(image: CropPixels, selection: CropPixels) {
        const epsilon = 0.01;
        return (
            selection.x >= image.x - epsilon &&
            selection.y >= image.y - epsilon &&
            selection.x + selection.width <= image.x + image.width + epsilon &&
            selection.y + selection.height <= image.y + image.height + epsilon
        );
    }
    async function save() {
        props.setSaving(true);
        if (cropper) cropper.getCropperCanvas()!.disabled = true;
        setError("");
        try {
            await props.api.saveCrop(props.photo.id, crop());
            await props.refresh();
            props.close();
        } catch (failure) {
            setError(failure instanceof RequestError ? failure.message : t("cropSaveError"));
        } finally {
            if (cropper) cropper.getCropperCanvas()!.disabled = false;
            props.setSaving(false);
        }
    }
    onSettled(() => {
        cropper = new Cropper(image, {
            template: `<cropper-canvas>
                <cropper-image initial-fit="contain" translatable scalable></cropper-image>
                <cropper-shade border-radius="50%"></cropper-shade>
                <cropper-handle action="move" plain></cropper-handle>
                <cropper-selection aspect-ratio="1" border-radius="50%" movable resizable precise>
                    <cropper-handle action="move" plain></cropper-handle>
                    <cropper-handle action="n-resize"></cropper-handle>
                    <cropper-handle action="e-resize"></cropper-handle>
                    <cropper-handle action="s-resize"></cropper-handle>
                    <cropper-handle action="w-resize"></cropper-handle>
                    <cropper-handle action="ne-resize"></cropper-handle>
                    <cropper-handle action="nw-resize"></cropper-handle>
                    <cropper-handle action="se-resize"></cropper-handle>
                    <cropper-handle action="sw-resize"></cropper-handle>
                </cropper-selection>
            </cropper-canvas>`,
        });

        const canvas = cropper.getCropperCanvas()!;
        const cropImage = cropper.getCropperImage()!;
        const selection = cropper.getCropperSelection()!;
        function imageBounds(): CropPixels {
            const rect = cropImage.$image.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            return {
                x: rect.left - canvasRect.left,
                y: rect.top - canvasRect.top,
                width: rect.width,
                height: rect.height,
            };
        }
        selection.addEventListener("change", (event) => {
            if (!ready() || resetting) return;
            // SAFETY: Cropper selection emits its rectangle in the change event detail.
            const next = (event as CustomEvent<CropPixels>).detail;
            const bounds = imageBounds();
            if (!contains(bounds, next)) event.preventDefault();
            else setCrop(normalized(next, bounds));
        });
        cropImage.addEventListener("transform", (event) => {
            if (!ready() || resetting) return;
            // SAFETY: Cropper image emits the proposed matrix in the transform event detail.
            const { matrix } = (event as CustomEvent<{ matrix: number[] }>).detail;
            const previous = cropImage.style.transform;
            cropImage.style.transform = `matrix(${matrix.join(", ")})`;
            const bounds = imageBounds();
            cropImage.style.transform = previous;
            if (!contains(bounds, selection)) {
                event.preventDefault();
                const current = cropImage.$getTransform();
                if (matrix.slice(0, 4).every((value, index) => value === current[index])) {
                    const x = Math.min(
                        selection.x - bounds.x,
                        Math.max(0, selection.x + selection.width - bounds.x - bounds.width),
                    );
                    const y = Math.min(
                        selection.y - bounds.y,
                        Math.max(0, selection.y + selection.height - bounds.y - bounds.height),
                    );
                    matrix[4]! += x;
                    matrix[5]! += y;
                    resetting = true;
                    cropImage.$setTransform(matrix);
                    resetting = false;
                    setCrop(normalized(selection, imageBounds()));
                }
                return;
            }
            queueMicrotask(() => {
                if (!disposed) setCrop(normalized(selection, imageBounds()));
            });
        });
        void cropImage
            .$ready()
            .then((loaded) => {
                if (disposed) return;
                dimensions = { width: loaded.naturalWidth, height: loaded.naturalHeight };
                cropImage.$center("contain");
                apply(crop());
                setReady(true);
                let canvasSize = { width: canvas.clientWidth, height: canvas.clientHeight };
                resizeObserver = new ResizeObserver(() => {
                    const next = { width: canvas.clientWidth, height: canvas.clientHeight };
                    if (next.width === canvasSize.width && next.height === canvasSize.height)
                        return;
                    const bounds = imageBounds();
                    const fit = (size: typeof canvasSize) =>
                        Math.min(size.width / dimensions.width, size.height / dimensions.height);
                    const scale = fit(next) / fit(canvasSize);
                    const x =
                        next.width / 2 +
                        (bounds.x + bounds.width / 2 - canvasSize.width / 2) * scale;
                    const y =
                        next.height / 2 +
                        (bounds.y + bounds.height / 2 - canvasSize.height / 2) * scale;
                    resetting = true;
                    cropImage.$scale(scale);
                    const scaled = imageBounds();
                    cropImage.$move(
                        x - scaled.x - scaled.width / 2,
                        y - scaled.y - scaled.height / 2,
                    );
                    resetting = false;
                    canvasSize = next;
                    apply(crop());
                });
                resizeObserver.observe(canvas);
            })
            .catch(() => {
                if (!disposed) setError(t("cropLoadError"));
            });
    });
    onCleanup(() => {
        disposed = true;
        resizeObserver?.disconnect();
        cropper?.destroy();
    });

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
