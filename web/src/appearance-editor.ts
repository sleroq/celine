import type { Appearance, AppearanceValue } from "./api";

export function updateAppearanceSection(
    appearance: Appearance,
    section: "profile" | "name",
    value: AppearanceValue | null,
): Appearance {
    return { ...appearance, [section]: value };
}
