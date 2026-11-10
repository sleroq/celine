import { createSignal, createStore, reconcile, untrack } from "solid-js";
import { RequestError } from "./api";
import type { AccountApi, EmojiChoice, Emojis } from "./api";
import { t } from "./i18n";
import { createEmojiPackCache } from "./emoji-pack-cache";

type Pack = { choices?: EmojiChoice[]; loading: boolean; error: string };

export function createEmojiPacks(api: AccountApi) {
    const [activeId, setActiveId] = createSignal("");
    const [catalog, setCatalog] = createStore<{
        sets: Emojis["sets"];
        packs: Record<string, Pack | undefined>;
    }>({ sets: [], packs: {} });
    const named = createEmojiPackCache(api);
    const [ids, setIds] = createStore<Record<string, boolean>>({});
    function pack(id: string) {
        return id ? named.get(id) : catalog.packs[""];
    }
    let indexedPacks: (EmojiChoice[] | undefined)[] = [];
    let choicesById = new Map<string, EmojiChoice>();

    function find(id: string) {
        const packs = Object.keys(ids).map((id) => pack(id)?.choices);
        if (
            packs.length !== indexedPacks.length ||
            packs.some((choices, index) => choices !== indexedPacks[index])
        ) {
            indexedPacks = packs;
            // Track pack replacements, not every immutable ID indexed.
            choicesById = untrack(() => {
                const choices = new Map<string, EmojiChoice>();
                for (const pack of packs) {
                    for (const choice of pack ?? []) {
                        if (!choices.has(choice.id)) choices.set(choice.id, choice);
                    }
                }
                return choices;
            });
        }
        return choicesById.get(id);
    }

    async function select(id = activeId()) {
        setActiveId(id);
        setIds((draft) => {
            draft[id] = true;
        });
        const cached = pack(id);
        if (cached?.loading) return;
        if (id) return named.load(id);
        setCatalog((draft) => {
            draft.packs[id] = { loading: true, error: "" };
        });
        try {
            const result = await api.request("emojis");
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
            return pack(activeId());
        },
        get groups() {
            const choices = pack(activeId())?.choices;
            if (!choices) return [];
            if (activeId()) return [{ kind: "pack" as const, choices }];
            const collectibles = choices.filter((emoji) => emoji.source_kind === "collectible");
            return [
                {
                    kind: "recent" as const,
                    choices: choices.filter((emoji) => emoji.source_kind === "recent"),
                },
                ...(collectibles.length
                    ? [{ kind: "collectible" as const, choices: collectibles }]
                    : []),
                {
                    kind: "default" as const,
                    choices: choices.filter(
                        (emoji) =>
                            emoji.source_kind !== "recent" && emoji.source_kind !== "collectible",
                    ),
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
        find,
    };
}
