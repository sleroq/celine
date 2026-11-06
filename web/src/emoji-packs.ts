import { createSignal, createStore, reconcile } from "solid-js";
import { RequestError } from "./api";
import type { AccountApi, EmojiChoice, Emojis } from "./api";
import { t } from "./i18n";

type Pack = { choices?: EmojiChoice[]; loading: boolean; error: string };

export function createEmojiPacks(api: AccountApi) {
    const [activeId, setActiveId] = createSignal("");
    const [catalog, setCatalog] = createStore<{
        sets: Emojis["sets"];
        packs: Record<string, Pack | undefined>;
    }>({ sets: [], packs: {} });

    async function select(id = activeId()) {
        setActiveId(id);
        const cached = catalog.packs[id];
        if (cached?.loading || (id && cached?.choices)) return;
        setCatalog((draft) => {
            draft.packs[id] = { loading: true, error: "" };
        });
        try {
            const result = id
                ? await api.request(`emojis/sets/${encodeURIComponent(id)}`)
                : await api.request("emojis");
            setCatalog((draft) => {
                if ("sets" in result) reconcile(result.sets, "id")(draft.sets);
                draft.packs[id] = { choices: result.choices, loading: false, error: "" };
            });
        } catch (failure) {
            setCatalog((draft) => {
                draft.packs[id] = {
                    loading: false,
                    error:
                        failure instanceof RequestError
                            ? failure.message
                            : t("emojiPacksLoadError"),
                };
            });
        }
    }

    return {
        get sets() {
            return catalog.sets;
        },
        get activeId() {
            return activeId();
        },
        get active() {
            return catalog.packs[activeId()];
        },
        get groups() {
            const choices = catalog.packs[activeId()]?.choices;
            if (!choices) return [];
            if (activeId()) return [{ kind: "pack" as const, choices }];
            return [
                {
                    kind: "recent" as const,
                    choices: choices.filter((emoji) => emoji.source_kind === "recent"),
                },
                {
                    kind: "default" as const,
                    choices: choices.filter((emoji) => emoji.source_kind !== "recent"),
                },
            ];
        },
        get title() {
            return catalog.sets.find((set) => set.id === activeId())?.title ?? t("recentDefault");
        },
        get count() {
            return catalog.sets.find((set) => set.id === activeId())?.count ?? 24;
        },
        select,
        find(id: string) {
            for (const pack of Object.values(catalog.packs)) {
                const choice = pack?.choices?.find((emoji) => emoji.id === id);
                if (choice) return choice;
            }
        },
    };
}
