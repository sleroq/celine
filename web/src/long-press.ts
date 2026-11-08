type Preview = { show: () => boolean; hide: () => void; cancel?: () => void };
const previews = new Map<Element, Preview>();
const clickSuppression = new WeakMap<Document, () => void>();

export function longPress(element: HTMLElement, show: () => boolean, hide: () => void) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pointer: { id: number; x: number; y: number } | undefined;
    let active: Preview | undefined;
    const preview: Preview = { show, hide };
    previews.set(element, preview);
    const document = element.ownerDocument;

    function cancel() {
        clearTimeout(timer);
        pointer = undefined;
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", end, true);
        document.removeEventListener("pointercancel", end, true);
        document.removeEventListener("scroll", cancel, true);
        document.defaultView?.removeEventListener("blur", cancel);
        if (active) {
            document.removeEventListener("touchmove", blockDrag, true);
            document.removeEventListener("mousemove", blockDrag, true);
            document.removeEventListener("dragstart", blockDrag, true);
        }
        active?.hide();
        if (active) active.cancel = undefined;
        active = undefined;
    }
    function down(event: PointerEvent) {
        cancel();
        clickSuppression.get(document)?.();
        if (!event.isPrimary || event.button !== 0) return;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", end, true);
        document.addEventListener("pointercancel", end, true);
        document.addEventListener("scroll", cancel, true);
        document.defaultView?.addEventListener("blur", cancel);
        timer = setTimeout(() => {
            if (show()) {
                active = preview;
                active.cancel = cancel;
                document.addEventListener("touchmove", blockDrag, {
                    capture: true,
                    passive: false,
                });
                document.addEventListener("mousemove", blockDrag, true);
                document.addEventListener("dragstart", blockDrag, true);
                document.addEventListener("click", click, true);
                document.addEventListener("pointerdown", clearClickSuppression, true);
                clickSuppression.set(document, clearClickSuppression);
            }
        }, 500);
    }
    function move(event: PointerEvent) {
        if (pointer?.id !== event.pointerId) return;
        if (active) {
            blockDrag(event);
            let target = document.elementFromPoint(event.clientX, event.clientY);
            while (target) {
                const next = previews.get(target);
                if (next) {
                    if (next !== active && next.show()) {
                        active.hide();
                        active.cancel = undefined;
                        active = next;
                        active.cancel = cancel;
                    }
                    break;
                }
                target = target.parentElement;
            }
            return;
        }
        if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) cancel();
    }
    function end(event: PointerEvent) {
        if (pointer?.id !== event.pointerId) return;
        if (event.type === "pointercancel" && active) clearClickSuppression();
        cancel();
    }
    function blockDrag(event: Event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    function dragStart(event: Event) {
        if (active) blockDrag(event);
        else cancel();
    }
    function clearClickSuppression() {
        document.removeEventListener("click", click, true);
        document.removeEventListener("pointerdown", clearClickSuppression, true);
        clickSuppression.delete(document);
    }
    function click(event: MouseEvent) {
        if (event.detail === 0) return;
        clearClickSuppression();
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    function contextMenu(event: MouseEvent) {
        if (active) event.preventDefault();
    }
    element.addEventListener("pointerdown", down);
    element.addEventListener("contextmenu", contextMenu);
    element.addEventListener("dragstart", dragStart, true);
    return () => {
        preview.cancel?.();
        cancel();
        previews.delete(element);
        if (clickSuppression.get(document) === clearClickSuppression) clearClickSuppression();
        element.removeEventListener("pointerdown", down);
        element.removeEventListener("contextmenu", contextMenu);
        element.removeEventListener("dragstart", dragStart, true);
    };
}
