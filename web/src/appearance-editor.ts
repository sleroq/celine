import type { Appearance, AppearanceValue } from "./api";

export function updateAppearanceSection(
    appearance: Appearance,
    section: "profile" | "name",
    value: AppearanceValue | null,
): Appearance {
    return { ...appearance, [section]: value };
}

export function createAppearanceDraft() {
    let initialized = false;
    return {
        edit() {
            initialized = true;
        },
        initialize(current: Appearance | null | undefined) {
            if (initialized || !current) return;
            initialized = true;
            return structuredClone(current);
        },
    };
}
