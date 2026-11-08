import { createEffect, onCleanup } from "solid-js";
import type { Appearance } from "./api";
import { createAutosave } from "./autosave";

export function createPhotoAppearance(
    current: () => Appearance | null | undefined,
    write: (value: Appearance) => Promise<void>,
    refresh: () => Promise<void>,
) {
    const autosave = createAutosave(write, refresh);
    function server(): Appearance {
        return current() ?? { profile: null, name: null };
    }
    createEffect(
        () => [autosave.status(), autosave.draft(), server()] as const,
        ([status, draft, value]) => {
            if (status === "saved" && draft && JSON.stringify(draft) === JSON.stringify(value))
                autosave.acknowledge();
        },
    );
    onCleanup(autosave.dispose);
    return { ...autosave, value: () => autosave.draft() ?? server() };
}
