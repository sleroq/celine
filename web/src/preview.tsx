import "@fontsource-variable/manrope";
import { render } from "@solidjs/web";
import { createPreviewFetch, previewMediaUrl, type PreviewSnapshot } from "./preview-runtime";
import type { Appearance, EmojiChoice } from "./api";
import { locale } from "./i18n";
import "./style.css";
import "./ui.css";
import "./preview.css";

// SAFETY: this checked-in file is produced by the typed allowlist exporter and covered by snapshot tests.
const snapshot = (await (
    await fetch(new URL("preview-data/snapshot.json", document.baseURI))
).json()) as PreviewSnapshot;
const publicUrl = (path: string) => new URL(path, document.baseURI).href;
for (const account of snapshot.accounts) {
    const profile = account.state.profile;
    if (profile?.photo_url) profile.photo_url = publicUrl(profile.photo_url);
    if (profile?.emoji) profile.emoji.media_url = publicUrl(profile.emoji.media_url);
    function rewriteEmoji(emoji: EmojiChoice) {
        if (emoji.thumbnail_url) emoji.thumbnail_url = publicUrl(emoji.thumbnail_url);
    }
    function rewriteAppearance(appearance: Appearance | null | undefined) {
        if (appearance?.profile?.emoji) rewriteEmoji(appearance.profile.emoji);
        if (appearance?.name?.emoji) rewriteEmoji(appearance.name.emoji);
    }
    rewriteAppearance(profile?.appearance);
    for (const photo of account.state.photos) {
        if (photo.emoji_status) rewriteEmoji(photo.emoji_status);
        rewriteAppearance(photo.appearance);
    }
    account.state.appearance_presets.forEach(rewriteAppearance);
    account.state.selected_emojis.forEach(rewriteEmoji);
    account.emojis.choices.forEach(rewriteEmoji);
    account.catalog.choices.forEach(rewriteEmoji);
}
window.__previewMedia = (account, path) => {
    return previewMediaUrl(snapshot, account, path, document.baseURI);
};

// Install before evaluating App: no application request can reach a real API.
window.fetch = Object.assign(createPreviewFetch(snapshot, window.fetch.bind(window)), window.fetch);
const { default: App } = await import("./App");
document.documentElement.lang = locale;
render(
    () => (
        <>
            <header class="preview-banner">
                <strong>Celine preview</strong>
                <span>
                    Edits stay in memory and reset on reload.
                </span>
                <nav aria-label="Preview links">
                    <a href="https://github.com/sleroq/celine">GitHub</a>
                    <a href="https://github.com/sleroq/celine/releases">Download</a>
                </nav>
            </header>
            <App />
        </>
    ),
    document.getElementById("root")!,
);
