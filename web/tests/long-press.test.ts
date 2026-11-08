import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { longPress } from "../src/long-press";

afterEach(() => mock.restore());

function setup() {
    function idle() {}
    let fire = idle;
    // SAFETY: This fake only captures the zero-argument timeout callback used by longPress.
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
        fire = callback;
        return 1;
    }) as typeof setTimeout);
    spyOn(globalThis, "clearTimeout").mockImplementation(() => {
        fire = idle;
    });

    // SAFETY: Only blur listener registration is used on the fake window.
    const defaultView = new EventTarget() as Window;
    // SAFETY: Tests supply the document members used by the gesture below.
    const document = Object.assign(new EventTarget() as Document, {
        defaultView,
        elementFromPoint: mock((): HTMLElement | null => null),
    });
    const addGlobal = spyOn(document, "addEventListener");
    const removeGlobal = spyOn(document, "removeEventListener");
    const addBlur = spyOn(document.defaultView, "addEventListener");
    const removeBlur = spyOn(document.defaultView, "removeEventListener");
    // SAFETY: Tests supply the element members used by the gesture.
    const element = Object.assign(new EventTarget() as HTMLElement, { ownerDocument: document });
    const show = mock(() => true);
    const hide = mock(() => {});
    // SAFETY: The gesture only uses EventTarget methods and ownerDocument, supplied above.
    const detach = longPress(element as HTMLElement, show, hide);

    function pointer(type: string, target: EventTarget = element, extra = {}) {
        target.dispatchEvent(
            Object.assign(new Event(type), {
                pointerId: 1,
                isPrimary: true,
                button: 0,
                clientX: 10,
                clientY: 10,
                ...extra,
            }),
        );
    }
    function click(detail = 1) {
        const event = Object.assign(new Event("click", { cancelable: true }), { detail });
        document.dispatchEvent(event);
        return event.defaultPrevented;
    }

    return {
        document,
        element,
        show,
        hide,
        detach,
        pointer,
        click,
        fire: () => fire(),
        timer,
        addGlobal,
        removeGlobal,
        addBlur,
        removeBlur,
    };
}

test.each(["mouse", "touch", "pen"])(
    "held %s press previews and suppresses only its click",
    (pointerType) => {
        const gesture = setup();
        gesture.pointer("pointerdown", gesture.element, { pointerType });
        gesture.fire();
        expect(gesture.show).toHaveBeenCalledTimes(1);
        gesture.pointer("pointerup", gesture.document);
        expect(gesture.hide).toHaveBeenCalled();
        expect(gesture.click()).toBe(true);
        expect(gesture.click()).toBe(false);
        gesture.detach();
    },
);

test.each(["pointerup", "pointercancel", "pointermove", "scroll", "dragstart", "unmount"])(
    "%s cancels pending preview",
    (reason) => {
        const gesture = setup();
        gesture.pointer("pointerdown");
        if (reason === "unmount") gesture.detach();
        else if (reason === "scroll") gesture.document.dispatchEvent(new Event("scroll"));
        else if (reason === "dragstart") gesture.element.dispatchEvent(new Event("dragstart"));
        else gesture.pointer(reason, gesture.document, { clientX: 25 });
        gesture.fire();
        expect(gesture.show).not.toHaveBeenCalled();
        expect(gesture.click()).toBe(false);
        gesture.detach();
    },
);

test("normal clicks, keyboard activation, and disabled previews are not swallowed", () => {
    const gesture = setup();
    gesture.pointer("pointerdown");
    gesture.pointer("pointerup", gesture.document);
    expect(gesture.click()).toBe(false);
    gesture.pointer("pointerdown");
    gesture.fire();
    expect(gesture.click(0)).toBe(false);
    gesture.pointer("pointerdown");
    gesture.show.mockReturnValue(false);
    gesture.fire();
    expect(gesture.click()).toBe(false);
    gesture.detach();
});

test.each(["pointerup", "pointercancel", "pointermove", "scroll", "blur", "dragstart", "unmount"])(
    "global listeners exist only during a gesture ending with %s",
    (reason) => {
        const gesture = setup();
        expect(gesture.addGlobal).not.toHaveBeenCalled();
        expect(gesture.addBlur).not.toHaveBeenCalled();
        gesture.pointer("pointerdown", gesture.element, { button: 2 });
        expect(gesture.addGlobal).not.toHaveBeenCalled();
        gesture.pointer("pointerdown");
        expect(gesture.addGlobal.mock.calls.map(([type]) => type)).toEqual([
            "pointermove",
            "pointerup",
            "pointercancel",
            "scroll",
        ]);
        expect(gesture.addBlur).toHaveBeenCalledTimes(1);
        gesture.removeGlobal.mockClear();
        gesture.removeBlur.mockClear();
        if (reason === "unmount") gesture.detach();
        else if (reason === "blur") gesture.document.defaultView.dispatchEvent(new Event("blur"));
        else if (reason === "scroll") gesture.document.dispatchEvent(new Event("scroll"));
        else if (reason === "dragstart") gesture.element.dispatchEvent(new Event("dragstart"));
        else gesture.pointer(reason, gesture.document, { clientX: 25 });
        expect(gesture.removeGlobal.mock.calls).toEqual(gesture.addGlobal.mock.calls);
        expect(gesture.removeBlur.mock.calls).toEqual(gesture.addBlur.mock.calls);
        gesture.hide.mockClear();
        gesture.document.dispatchEvent(new Event("scroll"));
        gesture.document.defaultView.dispatchEvent(new Event("blur"));
        expect(gesture.hide).not.toHaveBeenCalled();
        gesture.pointer("pointerdown");
        expect(gesture.addGlobal).toHaveBeenCalledTimes(reason === "unmount" ? 4 : 8);
        gesture.detach();
    },
);

test("active hold switches only to enabled registered entries using hit testing and suppresses release click", () => {
    const gesture = setup();
    // SAFETY: Tests supply the element members used by the gesture.
    const next = Object.assign(new EventTarget() as HTMLElement, {
        ownerDocument: gesture.element.ownerDocument,
    });
    const show = mock(() => true);
    const hide = mock(() => {});
    // SAFETY: The fake provides the EventTarget and ownerDocument used by longPress.
    const entry = next as HTMLElement;
    const detach = longPress(entry, show, hide);
    gesture.pointer("pointerdown");
    gesture.fire();
    gesture.document.elementFromPoint.mockReturnValue(entry);
    gesture.pointer("pointermove", gesture.document, { clientX: 100 });
    expect(show).toHaveBeenCalledTimes(1);
    expect(gesture.hide).toHaveBeenCalledTimes(1);
    gesture.document.elementFromPoint.mockReturnValue(null);
    gesture.pointer("pointermove", gesture.document, { clientX: 150 });
    expect(hide).not.toHaveBeenCalled();
    gesture.pointer("pointerup", gesture.document);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(gesture.click()).toBe(true);
    detach();
    gesture.detach();
});

test("disabled entries do not replace the preview and unmounting the active entry ends the gesture", () => {
    const gesture = setup();
    // SAFETY: Tests supply the element members used by the gesture.
    const next = Object.assign(new EventTarget() as HTMLElement, {
        ownerDocument: gesture.element.ownerDocument,
    });
    const show = mock(() => false);
    const hide = mock(() => {});
    // SAFETY: The fake provides the EventTarget and ownerDocument used by longPress.
    const entry = next as HTMLElement;
    const detach = longPress(entry, show, hide);
    gesture.pointer("pointerdown");
    gesture.fire();
    gesture.document.elementFromPoint.mockReturnValue(entry);
    gesture.pointer("pointermove", gesture.document, { clientX: 100 });
    expect(gesture.hide).not.toHaveBeenCalled();
    show.mockReturnValue(true);
    gesture.pointer("pointermove", gesture.document, { clientX: 110 });
    detach();
    expect(hide).toHaveBeenCalledTimes(1);
    gesture.pointer("pointermove", gesture.document, { clientX: 120 });
    expect(show).toHaveBeenCalledTimes(2);
    gesture.detach();
});

test.each(["pointerup", "pointercancel"])(
    "%s does not leave suppression on an unrelated subsequent pointer interaction",
    (ending) => {
        const gesture = setup();
        gesture.pointer("pointerdown");
        gesture.fire();
        gesture.pointer(ending, gesture.document);
        if (ending === "pointercancel") expect(gesture.click()).toBe(false);
        // This pointerdown is outside every registered preview element.
        gesture.pointer("pointerdown", gesture.document);
        expect(gesture.click()).toBe(false);
        gesture.detach();
    },
);

test("a completed hold still suppresses its synthesized click before the next pointerdown", () => {
    const gesture = setup();
    gesture.pointer("pointerdown");
    gesture.fire();
    gesture.pointer("pointerup", gesture.document);
    expect(gesture.click()).toBe(true);
    expect(gesture.click()).toBe(false);
    gesture.detach();
});

test.each(["dragstart", "pointermove", "touchmove", "mousemove"])(
    "active hold blocks %s before Sortable can initiate a drag",
    (type) => {
        const gesture = setup();
        const target = type === "dragstart" ? gesture.element : gesture.document;
        const sortable = mock(() => {});
        target.addEventListener(type, sortable);
        gesture.pointer("pointerdown");
        gesture.fire();
        const event = Object.assign(new Event(type, { cancelable: true }), {
            pointerId: 1,
            clientX: 100,
            clientY: 10,
        });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(sortable).not.toHaveBeenCalled();
        expect(gesture.hide).not.toHaveBeenCalled();
        gesture.pointer("pointerup", gesture.document);
        expect(gesture.hide).toHaveBeenCalledTimes(1);
        gesture.detach();
    },
);

test.each(["dragstart", "pointermove", "touchmove", "mousemove"])(
    "before a hold %s remains available for normal reorder",
    (type) => {
        const gesture = setup();
        const target = type === "dragstart" ? gesture.element : gesture.document;
        const sortable = mock(() => {});
        target.addEventListener(type, sortable);
        gesture.pointer("pointerdown");
        const event = Object.assign(new Event(type, { cancelable: true }), {
            pointerId: 1,
            clientX: 100,
            clientY: 10,
        });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(sortable).toHaveBeenCalledTimes(1);
        gesture.detach();
    },
);

// Sortable marks the ancestor <li> draggable, so dragstart does not pass
// through the preview's button. It must also be blocked at document capture.
test("active hold blocks a sortable ancestor's native dragstart", () => {
    const gesture = setup();
    gesture.pointer("pointerdown");
    gesture.fire();
    const drag = new Event("dragstart", { cancelable: true });
    gesture.document.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    gesture.pointer("pointerup", gesture.document);
    const next = new Event("dragstart", { cancelable: true });
    gesture.document.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
    gesture.detach();
});
