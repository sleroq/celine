import type { JSX } from "@solidjs/web";
import { onCleanup, onSettled } from "solid-js";
import { Button } from "./components/ui";
import { t } from "./i18n";

export function Modal(props: {
    label: string;
    onDismiss: () => void;
    children: JSX.Element;
    ref?: (element: HTMLDialogElement) => void;
}) {
    let dialog!: HTMLDialogElement;
    const returnFocus = document.activeElement;

    onSettled(() => dialog.showModal());
    onCleanup(() => {
        dialog.close();
        if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    });

    return (
        <dialog
            ref={(element) => {
                dialog = element;
                props.ref?.(element);
            }}
            class="w-[min(36rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-auto rounded-xl border-0 bg-surface p-5 text-foreground shadow-xl backdrop:bg-black/65"
            aria-label={props.label}
            onCancel={(event) => {
                event.preventDefault();
                props.onDismiss();
            }}
            onPointerDown={(event) => {
                if (event.target !== dialog) return;
                const bounds = dialog.getBoundingClientRect();
                if (
                    event.clientX < bounds.left ||
                    event.clientX > bounds.right ||
                    event.clientY < bounds.top ||
                    event.clientY > bounds.bottom
                ) {
                    props.onDismiss();
                }
            }}
        >
            {props.children}
        </dialog>
    );
}

export function ModalCloseFooter(props: {
    onDismiss: () => void;
    disabled?: boolean;
    ref?: (element: HTMLButtonElement) => void;
}) {
    return (
        <div class="flex justify-end gap-2">
            <Button
                variant="secondary"
                disabled={props.disabled}
                ref={props.ref}
                onClick={props.onDismiss}
            >
                {t("closePhotoSettings")}
            </Button>
        </div>
    );
}
