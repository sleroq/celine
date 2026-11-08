import type { Appearance, Settings, State } from "./api";

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

export function createPreviewFetch(
    settings: PreviewSettings,
    fallback: Window["fetch"],
): Window["fetch"] {
    const profile = { name: "Demo account", premium: true, updated_at: 0 };
    const auth = { status: "authorized" as const, name: "Demo account", premium: true };
    const state: State = {
        ...structuredClone(settings),
        active_account_id: "preview",
        accounts: [{ id: "preview", pending: false, auth, profile }],
        auth,
        profile,
        photos: [],
        photo_cache: { status: "ready", photos: [], recovery: {} },
        appearance_presets: [],
        applied_settings: null,
        applied_emoji_settings: null,
        applied_appearance_settings: null,
        next_rotation_at: null,
        next_emoji_rotation_at: null,
        next_appearance_rotation_at: null,
        selected_emoji_ids: [],
        selected_emojis: [],
        current_photo_id: null,
        last_error: null,
    };

    const schedules = {
        settings: ["settings", "applied_settings"],
        "emojis/settings": ["emoji_settings", "applied_emoji_settings"],
        "appearance/settings": ["appearance_settings", "applied_appearance_settings"],
    } as const;

    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (!/(^|\/)api(?:\/|$)/.test(url.pathname)) return fallback(input, init);

        const request = new Request(url, input instanceof Request ? input : init);
        const path = url.pathname.split(/\/api\/?/)[1]?.replace(/^accounts\/preview\//, "") ?? "";
        const method = request.method;

        if (method === "GET") {
            if (path === "state") return Response.json(state);
            if (path === "emojis") return Response.json({ choices: [], sets: [], premium: true });
            if (path === "appearance/catalog")
                return Response.json({
                    profile_colors: [],
                    name_colors: [],
                    choices: [],
                    sets: [],
                });
            if (path === "photos/history") return Response.json({ photos: [] });
            if (path === "emojis/search") return Response.json({ choices: [], next_offset: null });
            if (path.startsWith("emojis/sets/")) return Response.json({ choices: [] });
        }

        for (const [endpoint, [key, applied]] of Object.entries(schedules)) {
            if (path === endpoint && method === "PUT") {
                const value = await request.json();
                state[key] = parsePreviewSettings(JSON.stringify({ ...settings, [key]: value }))[
                    key
                ];
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

        if (path === "appearance/presets" && method === "PUT") {
            // SAFETY: only the typed local appearance editor submits this in-memory request.
            const body = (await request.json()) as { presets: Appearance[] };
            state.appearance_presets = body.presets;
            return new Response(null, { status: 204 });
        }
        if (path === "emojis" && method === "PUT") {
            state.selected_emoji_ids = [];
            return new Response(null, { status: 204 });
        }
        if (path === "photos/history/refresh" && method === "POST")
            return new Response(null, { status: 204 });

        // In particular, account/auth/upload actions must never fall through to the network.
        return Response.json(
            { error: "This action is unavailable in the static demo." },
            { status: 400 },
        );
    };
}
