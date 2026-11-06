import { locale, serverMessage, t } from "./i18n";
import type { MessageInfo } from "./i18n";

export type Settings = {
    enabled: boolean;
    mode: "ordered" | "random";
    interval_secs: number;
    jitter_secs: number | null;
};
export type Crop = { x: number; y: number; size: number };
export type Photo = {
    id: string;
    name: string;
    generated_name?: boolean | null;
    telegram_id: string | null;
    history_checked: boolean;
    crop: Crop | null;
};
export type State = {
    active_account_id: string;
    accounts: AccountSummary[];
    auth: {
        status: "unconfigured" | "disconnected" | "qr" | "qr_expired" | "password" | "authorized";
        qr_svg?: string | null;
        expires_at?: number | null;
        name?: string | null;
        premium?: boolean | null;
        message?: string | null;
        message_info?: MessageInfo | null;
    };
    photos: Photo[];
    photo_cache: { status: "refreshing" | "ready" | "error"; photos: { id: string }[] };
    settings: Settings;
    emoji_settings: Settings;
    applied_settings: Settings | null;
    applied_emoji_settings: Settings | null;
    profile: Profile | null;
    next_emoji_rotation_at: number | null;
    selected_emoji_ids: string[];
    selected_emojis: EmojiChoice[];
    next_rotation_at: number | null;
    current_photo_id: string | null;
    last_error: string | null;
    last_error_info?: MessageInfo | null;
};
export type AccountSummary = {
    id: string;
    pending: boolean;
    auth: State["auth"];
    profile: Profile | null;
};
export type Profile = {
    name: string;
    premium: boolean;
    photo_url?: string | null;
    emoji?: {
        id: string;
        label: string;
        media_url: string;
        format: "tgs" | "webm" | "image";
        expires_at?: number | null;
        text_color?: boolean;
    } | null;
    updated_at: number;
};
export type EmojiChoice = {
    id: string;
    label: string;
    source: string;
    source_kind?: "recent" | "default" | "pack" | null;
    thumbnail_url?: string;
    text_color?: boolean;
};
export type Emojis = {
    choices: EmojiChoice[];
    sets: { id: string; title: string; cover_url: string; count: number; text_color?: boolean }[];
    premium: boolean;
};

export class RequestError extends Error {}

type MutationMethod = "POST" | "PUT" | "DELETE";
type RequestBody =
    | Settings
    | { crop: Crop | null }
    | { password: string }
    | { ids: string[] }
    | { id: string }
    | FormData;

export const request = createRequest("/api/");

export type AccountApi = ReturnType<typeof accountApi>;

export function accountApi(id: string) {
    const path = `accounts/${encodeURIComponent(id)}`;
    const base = `/api/${path}/`;
    function photoUrl(photoId: string) {
        return `${base}photos/${encodeURIComponent(photoId)}`;
    }
    function photoHistoryUrl(telegramId: string) {
        return `${base}photos/history/${encodeURIComponent(telegramId)}`;
    }
    return {
        request: createRequest(base),
        photoUrl,
        photoHistoryUrl,
        selectedPhotoUrl: (photo: Pick<Photo, "id" | "crop">) =>
            `${photoUrl(photo.id)}?crop=${encodeURIComponent(JSON.stringify(photo.crop ?? null))}`,
        originalPhotoUrl: (id: string) => `${photoUrl(id)}/original`,
        saveCrop: (id: string, crop: Crop | null) =>
            createRequest(base)(`photos/${encodeURIComponent(id)}/crop`, "PUT", { crop }),
        emojiMediaUrl: (documentId: string) =>
            `${base}emojis/${encodeURIComponent(documentId)}/media`,
        activate: () => request(`${path}/active`, "PUT"),
        logout: () => request(path, "DELETE"),
    };
}

function createRequest(base: string) {
    function send(path: "state"): Promise<State>;
    function send(path: "photos/history"): Promise<{ photos: { id: string }[] }>;
    function send(path: "emojis"): Promise<Emojis>;
    function send(path: `emojis/sets/${string}`): Promise<Pick<Emojis, "choices">>;
    function send(path: string, method: MutationMethod, body?: RequestBody): Promise<void>;
    async function send(
        path: string,
        method: "GET" | MutationMethod = "GET",
        body?: RequestBody,
    ): Promise<State | Emojis | Pick<Emojis, "choices"> | { photos: { id: string }[] } | void> {
        const options: RequestInit = {
            method,
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
            headers:
                body && !(body instanceof FormData)
                    ? { "Content-Type": "application/json" }
                    : undefined,
        };
        if (body) options.body = body instanceof FormData ? body : JSON.stringify(body);

        const response = await fetch(`${base}${path}`, options).catch(() => {
            throw new RequestError(t("cannotReachCeline"));
        });

        if (!response.ok) {
            const data = await response.json().catch(() => null);
            const fallback = t("requestFailedStatus", { status: response.status });
            throw new RequestError(
                data?.error_info
                    ? serverMessage(data.error_info)
                    : locale === "en" && data?.error
                      ? data.error
                      : fallback,
            );
        }
        if (response.status === 204 || method !== "GET") return;
        return response.json();
    }
    return send;
}

export function reconcilePhotoOrder(ids: string[], available: string[]): string[] {
    const existing = new Set(available);
    const ordered = ids.filter((id) => existing.has(id));
    const orderedIds = new Set(ordered);
    return [...ordered, ...available.filter((id) => !orderedIds.has(id))];
}

export function moveItem(ids: string[], from: number, to: number): string[] {
    const result = [...ids];
    const [item] = result.splice(from, 1);
    result.splice(to, 0, item);
    return result;
}

const minutes = new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "minute",
    unitDisplay: "short",
});
const seconds = new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "second",
    unitDisplay: "short",
});

export function timeRemaining(timestamp: number, now: number): string {
    const remaining = Math.max(0, Math.ceil(timestamp - now));
    if (remaining < 60) return seconds.format(remaining);
    return `${minutes.format(Math.floor(remaining / 60))} ${seconds.format(remaining % 60)}`;
}
