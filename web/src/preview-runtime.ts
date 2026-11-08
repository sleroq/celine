import type { Appearance, AppearanceCatalog, Crop, Emojis, Settings, State } from "./api";

export type PreviewSettings = Pick<State, "settings" | "emoji_settings" | "appearance_settings">;

export function parsePreviewSettings(raw: string): PreviewSettings {
    const input = JSON.parse(raw);
    function parseSchedule(key: keyof PreviewSettings): Settings {
        const value = input[key];
        if (
            !value ||
            typeof value.enabled !== "boolean" ||
            !["ordered", "random"].includes(value.mode) ||
            !Number.isFinite(value.interval_secs) ||
            value.interval_secs <= 0 ||
            !(
                value.jitter_secs === null ||
                (Number.isFinite(value.jitter_secs) &&
                    value.jitter_secs >= 0 &&
                    value.jitter_secs < value.interval_secs)
            )
        )
            throw new Error(`Invalid preview ${key}: expected Settings`);
        // Only these fields can enter the bundle's runtime state.
        return {
            enabled: value.enabled,
            mode: value.mode,
            interval_secs: value.interval_secs,
            jitter_secs: value.jitter_secs,
        };
    }
    return {
        settings: parseSchedule("settings"),
        emoji_settings: parseSchedule("emoji_settings"),
        appearance_settings: parseSchedule("appearance_settings"),
    };
}

export type PreviewSnapshot = {
    accounts: {
        state: State;
        media: Record<string, string>;
        emojis: Emojis;
        catalog: AppearanceCatalog;
    }[];
};

export function previewMediaUrl(
    snapshot: PreviewSnapshot,
    account: string,
    path: string,
    base: string,
): string {
    const asset = snapshot.accounts.find((a) => a.state.active_account_id === account)?.media[path];
    return asset ? new URL(asset, base).href : "";
}

export function createPreviewFetch(
    snapshot: PreviewSnapshot,
    fallback: Window["fetch"],
): Window["fetch"] {
    const accounts = structuredClone(snapshot.accounts);
    let activeId = accounts[0]!.state.active_account_id;
    function summaries() {
        return accounts.map(({ state }) => ({
            id: state.active_account_id,
            pending: false,
            auth: state.auth,
            profile: state.profile,
        }));
    }
    const schedules = {
        settings: ["settings", "applied_settings"],
        "emojis/settings": ["emoji_settings", "applied_emoji_settings"],
        "appearance/settings": ["appearance_settings", "applied_appearance_settings"],
    } as const;

    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (!/(^|\/)api(?:\/|$)/.test(url.pathname)) return fallback(input, init);

        const request = new Request(url, input instanceof Request ? input : init);
        const route = url.pathname.split(/\/api\/?/)[1] ?? "";
        const scoped = /^accounts\/([^/]+)\/(.*)$/.exec(route);
        const account = accounts.find(
            (a) =>
                a.state.active_account_id === (scoped ? decodeURIComponent(scoped[1]!) : activeId),
        );
        if (!account) return Response.json({ error: "Unknown preview account" }, { status: 404 });
        const state = account.state;
        const path = scoped ? scoped[2] : route;
        const method = request.method;

        if (method === "GET") {
            if (path === "state")
                return Response.json({
                    ...state,
                    active_account_id: activeId,
                    accounts: summaries(),
                });
            if (path === "emojis") return Response.json(account.emojis);
            if (path === "appearance/catalog") return Response.json(account.catalog);
            if (path === "emojis/search") return Response.json({ choices: [], next_offset: null });
            if (path.startsWith("emojis/sets/")) return Response.json({ choices: [] });
        }

        if (scoped && path === "active" && method === "PUT") {
            activeId = state.active_account_id;
            return new Response(null, { status: 204 });
        }

        for (const [endpoint, [key, applied]] of Object.entries(schedules)) {
            if (path === endpoint && method === "PUT") {
                const value = await request.json();
                state[key] = parsePreviewSettings(JSON.stringify({ ...state, [key]: value }))[key];
                return new Response(null, { status: 204 });
            }
            if (path.startsWith(`${endpoint}/`) && method === "POST") {
                const action = path.slice(endpoint.length + 1);
                if (["start", "stop", "apply"].includes(action)) {
                    state[key].enabled =
                        action === "start" || (action === "apply" && state[key].enabled);
                    state[applied] = action === "stop" ? null : structuredClone(state[key]);
                    return new Response(null, { status: 204 });
                }
            }
        }

        if (path === "photos/order" && method === "POST") {
            // SAFETY: the typed UI submits these IDs to this in-memory-only endpoint.
            const body = (await request.json()) as { ids: string[] };
            state.photos.sort((a, b) => body.ids.indexOf(a.id) - body.ids.indexOf(b.id));
            return new Response(null, { status: 204 });
        }
        const photoRoute = /^photos\/([^/]+)\/(crop|emoji-status|appearance)$/.exec(path ?? "");
        const photo =
            photoRoute && state.photos.find((p) => p.id === decodeURIComponent(photoRoute[1]!));
        if (photo && photoRoute && method === "PUT") {
            const body = await request.json();
            if (photoRoute[2] === "crop") {
                // SAFETY: the typed crop editor supplies this in-memory-only request.
                const crop = body as { crop: Crop | null };
                photo.crop = crop.crop;
            }
            if (photoRoute[2] === "appearance") {
                // SAFETY: the typed appearance editor supplies this in-memory-only request.
                const appearance = body as Appearance;
                photo.appearance = appearance;
            }
            if (photoRoute[2] === "emoji-status")
                photo.emoji_status = account.emojis.choices.find((e) => e.id === body.id) ?? null;
            return new Response(null, { status: 204 });
        }

        if (path === "appearance/presets" && method === "PUT") {
            // SAFETY: only the typed local appearance editor submits this in-memory request.
            const body = (await request.json()) as { presets: Appearance[] };
            state.appearance_presets = body.presets;
            return new Response(null, { status: 204 });
        }
        if (path === "emojis" && method === "PUT") {
            // SAFETY: the typed UI submits these IDs to this in-memory-only endpoint.
            const body = (await request.json()) as { ids: string[] };
            state.selected_emoji_ids = body.ids.filter((id) =>
                account.emojis.choices.some((e) => e.id === id),
            );
            state.selected_emojis = account.emojis.choices.filter((e) =>
                state.selected_emoji_ids.includes(e.id),
            );
            return new Response(null, { status: 204 });
        }
        if (path === "photos/history/refresh" && method === "POST")
            return new Response(null, { status: 204 });

        // In particular, account/auth/upload actions must never fall through to the network.
        return Response.json(
            { error: "This action is unavailable in the public snapshot." },
            { status: 400 },
        );
    };
}
