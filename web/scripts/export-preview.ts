import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Appearance, AppearanceColor, EmojiChoice, Settings, State } from "../src/api";
import type { PreviewSnapshot } from "../src/preview-runtime";

// Never serialize an API object directly. Every published field is constructed below.
export function schedule(value: Settings): Settings {
    return {
        enabled: value.enabled,
        mode: value.mode,
        interval_secs: value.interval_secs,
        jitter_secs: value.jitter_secs,
    };
}
export async function exportPreview(
    origin = "http://127.0.0.1:7766",
    output = new URL("../preview-data/", import.meta.url),
) {
    async function get(path: string) {
        const response = await fetch(`${origin}/api/${path}`, { redirect: "error" });
        if (!response.ok) throw new Error(`Export endpoint failed (${response.status})`);
        return response;
    }

    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    const snapshot: PreviewSnapshot = { accounts: [] };
    // SAFETY: trusted local Celine API; only explicitly constructed fields below are serialized.
    const listing = (await (await get("state")).json()) as State;
    for (const [index, account] of listing.accounts.entries()) {
        const id = `preview-${index + 1}`;
        const base = `accounts/${encodeURIComponent(account.id)}/`;
        const raw: State = await (await get(`${base}state`)).json();
        async function media(endpoint: string) {
            const name = `${id}-${createHash("sha256").update(endpoint).digest("hex").slice(0, 20)}`;
            const response = await get(base + endpoint);
            const mime = response.headers.get("content-type")?.split(";")[0];
            const extensions = new Map([
                ["image/jpeg", "jpg"],
                ["image/png", "png"],
                ["image/webp", "webp"],
                ["image/gif", "gif"],
                ["application/x-tgsticker", "tgs"],
                ["application/gzip", "tgs"],
                ["application/octet-stream", "tgs"],
                ["video/webm", "webm"],
            ]);
            const extension = extensions.get(mime ?? "");
            if (!extension) throw new Error(`Unsupported preview media type: ${mime}`);
            const filename = `${name}.${extension}`;
            await writeFile(
                new URL(filename, output),
                new Uint8Array(await response.arrayBuffer()),
            );
            return `preview-data/${filename}`;
        }
        const mediaPaths: Record<string, string> = {};
        async function emoji(value: EmojiChoice): Promise<EmojiChoice> {
            const document = value.document_id ?? value.id;
            const endpoint = `emojis/${encodeURIComponent(document)}/media`;
            mediaPaths[endpoint] ??= await media(endpoint);
            return {
                id: value.id,
                label: value.label,
                source: value.source,
                source_kind: value.source_kind,
                document_id: value.document_id,
                text_color: value.text_color,
                thumbnail_url: mediaPaths[endpoint],
            };
        }
        async function appearance(value: Appearance): Promise<Appearance> {
            async function part(v: Appearance["profile"]) {
                return v ? { color: v.color, emoji: v.emoji ? await emoji(v.emoji) : null } : null;
            }
            return { profile: await part(value.profile), name: await part(value.name) };
        }
        const photos = [];
        for (const [i, photo] of raw.photos.entries()) {
            const photoId = `photo-${i + 1}`;
            mediaPaths[`photos/${photoId}`] = await media(`photos/${encodeURIComponent(photo.id)}`);
            photos.push({
                id: photoId,
                name: photo.name,
                generated_name: photo.generated_name,
                telegram_id: null,
                history_checked: true,
                crop: photo.crop
                    ? { x: photo.crop.x, y: photo.crop.y, size: photo.crop.size }
                    : null,
                emoji_status: photo.emoji_status ? await emoji(photo.emoji_status) : null,
                appearance: await appearance(photo.appearance),
            });
        }
        const profile = raw.profile
            ? {
                  name: raw.profile.name,
                  premium: raw.profile.premium,
                  updated_at: 0,
                  photo_url: raw.profile.photo_url ? await media("profile/photo") : null,
                  appearance: raw.profile.appearance
                      ? await appearance(raw.profile.appearance)
                      : null,
                  emoji: raw.profile.emoji
                      ? {
                            id: raw.profile.emoji.id,
                            label: raw.profile.emoji.label,
                            format: raw.profile.emoji.format,
                            text_color: raw.profile.emoji.text_color,
                            media_url: await media(
                                `emojis/${encodeURIComponent(raw.profile.emoji.id)}/media`,
                            ),
                        }
                      : null,
              }
            : null;
        const auth = {
            status: "authorized" as const,
            name: profile?.name,
            premium: profile?.premium,
        };
        const state: State = {
            active_account_id: id,
            accounts: [],
            auth,
            profile,
            photos,
            photo_cache: { status: "ready", photos: [], recovery: {} },
            settings: schedule(raw.settings),
            emoji_settings: schedule(raw.emoji_settings),
            appearance_settings: schedule(raw.appearance_settings),
            applied_settings: raw.applied_settings ? schedule(raw.applied_settings) : null,
            applied_emoji_settings: raw.applied_emoji_settings
                ? schedule(raw.applied_emoji_settings)
                : null,
            applied_appearance_settings: raw.applied_appearance_settings
                ? schedule(raw.applied_appearance_settings)
                : null,
            appearance_presets: await Promise.all(raw.appearance_presets.map(appearance)),
            selected_emoji_ids: [...raw.selected_emoji_ids],
            selected_emojis: await Promise.all(raw.selected_emojis.map(emoji)),
            current_photo_id: raw.current_photo_id
                ? (photos[raw.photos.findIndex((p) => p.id === raw.current_photo_id)]?.id ?? null)
                : null,
            next_rotation_at: null,
            next_emoji_rotation_at: null,
            next_appearance_rotation_at: null,
            last_error: null,
        };
        const catalog = await (await get(`${base}appearance/catalog`)).json();
        function colors(values: AppearanceColor[]) {
            return values.map((v) => ({
                id: v.id,
                colors: [...v.colors],
                dark_colors: [...v.dark_colors],
                bg_colors: v.bg_colors?.slice(),
                dark_bg_colors: v.dark_bg_colors?.slice(),
            }));
        }
        // Only selected/linked emoji media is published, not entire Telegram packs.
        snapshot.accounts.push({
            state,
            media: mediaPaths,
            emojis: {
                choices: state.selected_emojis,
                sets: [],
                premium: profile?.premium ?? false,
            },
            catalog: {
                profile_colors: colors(catalog.profile_colors),
                name_colors: colors(catalog.name_colors),
                choices: state.selected_emojis,
                sets: [],
            },
        });
    }
    await writeFile(new URL("snapshot.json", output), JSON.stringify(snapshot, null, 2) + "\n");
    console.log(
        `Exported ${snapshot.accounts.length} public accounts (${snapshot.accounts.map((a) => a.state.photos.length).join(", ")} photos).`,
    );
}
if (import.meta.main) await exportPreview();
