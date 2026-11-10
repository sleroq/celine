import { render } from "@solidjs/web";
import App from "../../../src/App";
import {
    createPreviewFetch,
    previewMediaUrl,
    type PreviewSnapshot,
} from "../../../src/preview-runtime";
import snapshot from "../../../preview-data/snapshot.json";
import "../../../src/style.css";
import "../../../src/ui.css";

// SAFETY: the checked-in preview snapshot is produced by the typed allowlist exporter and tested.
const local = structuredClone(snapshot) as PreviewSnapshot;
const accounts = local.accounts.sort(
    (a, b) => Number(a.state.profile?.premium) - Number(b.state.profile?.premium),
);
const stopped = accounts[0]!;
const running = accounts[1]!;
stopped.state.settings.enabled = false;
stopped.state.settings.interval_secs = 3600;
running.state.settings.enabled = true;
running.state.settings.interval_secs = 1200;
stopped.state.profile!.name = "Stopped account";
running.state.profile!.name = "Running account";
const originalFetch = window.fetch.bind(window);
const previewFetch = createPreviewFetch(local, originalFetch);
const writes: { url: string; body: string | undefined }[] = [];
let failed = false;
window.__previewMedia = (account, path) => previewMediaUrl(local, account, path, location.origin);
window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/settings") && init?.method === "PUT") {
        writes.push({ url, body: String(init.body) });
        if (!failed) {
            failed = true;
            return Response.json({ error: "Save unavailable" }, { status: 503 });
        }
    }
    return previewFetch(input, init);
}, window.fetch);
Object.assign(window, {
    writes,
    stoppedId: stopped.state.active_account_id,
    runningId: running.state.active_account_id,
});
render(() => <App />, document.getElementById("root")!);
