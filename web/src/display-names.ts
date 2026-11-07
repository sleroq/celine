import { locale, translate, type Locale } from "./i18n";

export function photoDisplayName(
    photo: { name: string; generated_name?: boolean | null },
    language: Locale = locale,
): string {
    return photo.generated_name ? translate(language, "telegramPhotoName") : photo.name;
}

export function emojiDisplayName(label: string, language: Locale = locale): string {
    return label === "Custom emoji" ? translate(language, "customEmoji") : label;
}
