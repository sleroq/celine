import "@fontsource-variable/manrope";
import { render } from "@solidjs/web";
import { createPreviewFetch, type PreviewSettings } from "./preview-runtime";
import { locale } from "./i18n";
import "./style.css";
import "./ui.css";
import "./preview.css";

declare const __PREVIEW_SETTINGS__: PreviewSettings;

// Install before evaluating App: no application request can reach a real API.
window.fetch = Object.assign(
    createPreviewFetch(__PREVIEW_SETTINGS__, window.fetch.bind(window)),
    window.fetch,
);
const { default: App } = await import("./App");
document.documentElement.lang = locale;
render(
    () => (
        <>
            <header class="preview-banner">
                <strong>Celine preview</strong>
                <span>
                    Synthetic demo data. Changes stay in this tab and reset on reload. No Telegram
                    connection.
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
