import { createSignal } from "solid-js";
import { RequestError } from "./api";
import type { AccountApi, EmojiChoice } from "./api";
import { t } from "./i18n";

type SearchState = {
    choices: EmojiChoice[];
    loading: boolean;
    error: string;
    nextOffset: number | null;
};

function emptySearch(): SearchState {
    return { choices: [], loading: false, error: "", nextOffset: null };
}

function emojiInput(query: string): string {
    const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
    if (!emoji.test(query)) return "";
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(query)]
        .map(({ segment }) => segment)
        .filter((segment) => segment.trim());
    return segments.every((segment) => emoji.test(segment)) ? segments.join(" ") : "";
}

export function createEmojiSearch(api: AccountApi) {
    const [query, setQuery] = createSignal("");
    const [state, setState] = createSignal<SearchState>(emptySearch());
    const discovered = new Map<string, EmojiChoice>();
    const preferredLanguages = navigator.languages?.length
        ? navigator.languages
        : navigator.language
          ? [navigator.language]
          : [];
    const languages = [...new Set([...preferredLanguages, "en"])].join(",");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let failedOffset = 0;

    async function load(offset: number, current: number) {
        const text = query().trim();
        const params = new URLSearchParams({ q: text, lang: languages, offset: String(offset) });
        const emoticon = emojiInput(text);
        if (emoticon) params.set("emoticon", emoticon);
        setState((previous) => ({ ...previous, loading: true, error: "" }));
        try {
            const result = await api.request(`emojis/search?${params}`);
            if (generation !== current) return;
            for (const choice of result.choices) discovered.set(choice.id, choice);
            setState((previous) => {
                const choices = offset ? [...previous.choices] : [];
                const ids = new Set(choices.map((choice) => choice.id));
                for (const choice of result.choices) {
                    if (!ids.has(choice.id)) {
                        ids.add(choice.id);
                        choices.push(choice);
                    }
                }
                return { choices, loading: false, error: "", nextOffset: result.next_offset };
            });
        } catch (failure) {
            if (generation !== current) return;
            failedOffset = offset;
            setState((previous) => ({
                ...previous,
                loading: false,
                error: failure instanceof RequestError ? failure.message : t("emojiSearchError"),
            }));
        }
    }

    function updateQuery(value: string) {
        clearTimeout(timer);
        const current = ++generation;
        setQuery(value);
        setState({ ...emptySearch(), loading: !!value.trim() });
        if (value.trim()) timer = setTimeout(() => void load(0, current), 300);
    }

    return {
        get query() {
            return query();
        },
        get state() {
            return state();
        },
        setQuery: updateQuery,
        find: (id: string) => discovered.get(id),
        loadMore() {
            const { loading, nextOffset } = state();
            if (!loading && nextOffset != null) void load(nextOffset, generation);
        },
        retry() {
            if (!state().loading && state().error) void load(failedOffset, generation);
        },
        dispose() {
            clearTimeout(timer);
            generation++;
        },
    };
}
