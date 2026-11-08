import { createSignal } from "solid-js";
import type { State } from "./api";

export function createAppState() {
    // Polls return JSON snapshots. Keep identical snapshots (and their references)
    // without mutating server values that editors may still retain in drafts.
    return createSignal<State | undefined>(undefined, {
        equals: (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
    });
}
