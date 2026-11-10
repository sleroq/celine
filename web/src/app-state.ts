import { createStore } from "solid-js";
import type { State } from "./api";

function reuseValue<T>(previous: T, next: T): T {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function reuseItems<T extends { id: string }>(previous: T[], next: T[]): T[] {
    if (previous === next) return previous;
    const byId = new Map(previous.map((item) => [item.id, item]));
    return next.map((item) => {
        const saved = byId.get(item.id);
        return saved ? reuseValue(saved, item) : item;
    });
}

function reuseFields<T extends object>(previous: T, next: T): T {
    const shared = { ...next };
    for (const key in next) shared[key] = reuseValue(previous[key], next[key]);
    return shared;
}

function shareState(previous: State, next: State): State {
    const shared = reuseFields(previous, next);
    shared.photos = reuseItems(previous.photos, shared.photos);
    shared.accounts = reuseItems(previous.accounts, shared.accounts);
    shared.selected_emojis = reuseItems(previous.selected_emojis, shared.selected_emojis);
    if (shared.photo_cache !== previous.photo_cache) {
        shared.photo_cache = {
            ...shared.photo_cache,
            photos: reuseItems(previous.photo_cache.photos, shared.photo_cache.photos),
        };
    }
    return shared;
}

export function createAppState() {
    // A keyed workspace retains its account's root; only account switches replace it.
    const [state, updateState] = createStore<{ current?: State }>({});
    let previous: State | undefined;

    function setState(next: State) {
        const sameAccount = previous?.active_account_id === next.active_account_id;
        const shared = previous && sameAccount ? shareState(previous, next) : next;
        updateState((draft) => {
            if (!sameAccount) {
                draft.current = { ...shared };
            } else {
                // Replace only top-level fields. Reconcile would mutate objects that
                // editors may still retain as the server baseline for their drafts.
                Object.assign(draft.current!, shared);
                for (const key of Object.keys(previous!)) {
                    if (!Object.hasOwn(shared, key)) Reflect.deleteProperty(draft.current!, key);
                }
            }
        });
        previous = shared;
    }

    function current(): State | undefined {
        return state.current;
    }
    return [current, setState] as const;
}
