import { createStore } from "solid-js";
import { RequestError } from "./api";
import type { AccountApi, EmojiChoice } from "./api";
import { t } from "./i18n";

type Pack = { choices?: EmojiChoice[]; loading: boolean; error: string };

export function createEmojiPackCache(api: AccountApi) {
    const [packs, setPacks] = createStore<Record<string, Pack | undefined>>({});
    const pending = new Map<string, Promise<void>>();

    function load(id: string): Promise<void> {
        if (packs[id]?.choices) return Promise.resolve();
        const existing = pending.get(id);
        if (existing) return existing;
        setPacks((draft) => {
            draft[id] = { loading: true, error: "" };
        });
        const request = (async () => {
            try {
                const result = await api.request(`emojis/sets/${encodeURIComponent(id)}`);
                setPacks((draft) => {
                    draft[id] = { choices: result.choices, loading: false, error: "" };
                });
            } catch (failure) {
                setPacks((draft) => {
                    draft[id] = {
                        loading: false,
                        error:
                            failure instanceof RequestError
                                ? failure.message
                                : t("emojiPacksLoadError"),
                    };
                });
            } finally {
                pending.delete(id);
            }
        })();
        pending.set(id, request);
        return request;
    }

    return { get: (id: string) => packs[id], load };
}
