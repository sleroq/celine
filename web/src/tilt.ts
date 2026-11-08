export function tilt(event: PointerEvent & { currentTarget: HTMLElement }, strength = 28) {
    if (event.pointerType !== "mouse") return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    element.style.setProperty(
        "--tilt-x",
        `${((rect.top + rect.height / 2 - event.clientY) / rect.height) * strength}deg`,
    );
    element.style.setProperty(
        "--tilt-y",
        `${((event.clientX - rect.left - rect.width / 2) / rect.width) * strength}deg`,
    );
}

export function resetTilt(event: PointerEvent & { currentTarget: HTMLElement }) {
    event.currentTarget.style.removeProperty("--tilt-x");
    event.currentTarget.style.removeProperty("--tilt-y");
}
