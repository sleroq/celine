import { expect } from "bun:test";
import { createRoot, createSignal, flush } from "solid-js";
import type { Appearance } from "../../src/api";
import { createPhotoAppearance } from "../../src/photo-appearance";

function appearance(color: number): Appearance {
    return { profile: { color, emoji: null }, name: null };
}

await (async () => {
    let dispose!: () => void;
    const [current, setCurrent] = createSignal<Appearance>();
    let fail = false;
    const save = createRoot((end) => {
        dispose = end;
        return createPhotoAppearance(
            current,
            async () => {
                if (fail) throw new Error("offline");
            },
            async () => {},
        );
    });
    try {
        flush();
        expect(save.value()).toEqual({ profile: null, name: null });
        setCurrent(appearance(1));
        flush();
        expect(save.value()).toEqual(appearance(1));

        save.edit(appearance(2));
        setCurrent(appearance(2));
        flush();
        expect(save.status()).toBe("pending");
        expect(save.draft()).toEqual(appearance(2));
        setCurrent(appearance(1));
        await save.flush();
        flush();
        expect(save.status()).toBe("saved");
        expect(save.draft()).toEqual(appearance(2));
        expect(save.value()).toEqual(appearance(2));

        setCurrent(appearance(2));
        flush();
        expect(save.draft()).toBeUndefined();
        setCurrent(appearance(3));
        flush();
        expect(save.value()).toEqual(appearance(3));

        fail = true;
        save.edit(appearance(4));
        await expect(save.flush()).rejects.toThrow("offline");
        setCurrent(appearance(4));
        flush();
        expect(save.draft()).toEqual(appearance(4));
        setCurrent(appearance(5));
        flush();
        expect(save.value()).toEqual(appearance(4));
        fail = false;
        await save.retry();
        flush();
        expect(save.draft()).toEqual(appearance(4));
        setCurrent(appearance(4));
        flush();
        expect(save.draft()).toBeUndefined();
    } finally {
        dispose();
    }
})();
