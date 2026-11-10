import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { AppearanceEditor, unchangedAppearance } from "../../../src/Appearance";
import { accountApi, type AppearanceCatalog } from "../../../src/api";
import "../../../src/style.css";

const choice = { id: "leaf", label: "Leaf", source: "Nature" };
const catalog: AppearanceCatalog = {
    profile_colors: [],
    name_colors: [],
    choices: [{ id: "default", label: "Default", source: "Default" }],
    sets: [{ id: "nature", title: "Nature", count: 1, cover_url: "" }],
};
const calls = { catalog: 0, packs: 0 };
Object.assign(window, { calls });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("appearance/catalog")) {
            calls.catalog++;
            return Response.json(catalog);
        }
        if (url.endsWith("emojis/sets/nature")) {
            calls.packs++;
            return calls.packs === 1
                ? Response.json({ error: "Pack unavailable" }, { status: 503 })
                : Response.json({ choices: [choice] });
        }
        return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
);
function Fixture() {
    const [value, setValue] = createSignal(unchangedAppearance());
    return (
        <AppearanceEditor
            api={accountApi("fixture")}
            value={value()}
            change={setValue}
            disabled={false}
            catalog={location.search ? undefined : catalog}
        />
    );
}
render(() => <Fixture />, document.getElementById("root")!);
