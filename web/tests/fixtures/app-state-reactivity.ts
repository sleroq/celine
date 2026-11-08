import assert from "node:assert/strict";
import { createEffect, createRoot, flush } from "solid-js";
import { createAppState } from "../../src/app-state";
import type { State } from "../../src/api";

const settings = { enabled: false, mode: "ordered" as const, interval_secs: 60, jitter_secs: null };
const initial: State = {
    active_account_id: "personal",
    accounts: [
        { id: "personal", pending: false, auth: { status: "authorized" }, profile: null },
        { id: "work", pending: false, auth: { status: "authorized" }, profile: null },
    ],
    auth: { status: "authorized", name: "Personal" },
    photos: ["a", "b"].map((id) => ({
        id,
        name: id,
        telegram_id: null,
        history_checked: true,
        crop: null,
        emoji_status: null,
        appearance: { profile: null, name: null },
    })),
    photo_cache: { status: "ready", photos: [{ id: "a" }, { id: "b" }], recovery: {} },
    settings,
    emoji_settings: { ...settings },
    appearance_settings: { ...settings },
    appearance_presets: [{ profile: { color: 1, emoji: null }, name: null }],
    applied_appearance_settings: null,
    next_appearance_rotation_at: null,
    applied_settings: null,
    applied_emoji_settings: null,
    profile: null,
    next_emoji_rotation_at: null,
    selected_emoji_ids: ["star"],
    selected_emojis: [{ id: "star", label: "⭐", source: "recent" }],
    next_rotation_at: null,
    current_photo_id: "a",
    last_error: null,
};

createRoot((dispose) => {
    const [state, setState] = createAppState();
    let evaluations = 0;
    let observedValue: State | undefined;
    function observed() {
        return observedValue;
    }
    createEffect(
        () => {
            evaluations++;
            return state();
        },
        (value) => {
            observedValue = value;
        },
    );
    flush();
    assert.equal(observed(), undefined);
    setState(initial);
    flush();
    assert.equal(observed(), initial);
    const loadedEvaluations = evaluations;

    setState(structuredClone(initial));
    flush();
    assert.equal(evaluations, loadedEvaluations);
    assert.equal(observed(), initial);
    assert.equal(state()?.photos[0], initial.photos[0]);

    // Retained server values must not change underneath local editor drafts.
    const draft = { ...initial.settings, interval_secs: 120 };
    const retainedPreset = initial.appearance_presets[0];
    const changed = structuredClone(initial);
    changed.photos[0]!.name = "Updated";
    changed.settings.interval_secs = 90;
    changed.appearance_presets[0]!.profile!.color = 2;
    setState(changed);
    flush();
    assert.equal(evaluations, loadedEvaluations + 1);
    assert.equal(observed()?.photos[0]?.name, "Updated");
    assert.equal(state()?.settings.interval_secs, 90);
    assert.equal(initial.photos[0]?.name, "a");
    assert.equal(retainedPreset?.profile?.color, 1);
    assert.equal(draft.interval_secs, 120);

    const removed = structuredClone(changed);
    removed.photos.splice(0, 1);
    removed.photo_cache.photos.splice(0, 1);
    removed.selected_emoji_ids = [];
    removed.selected_emojis = [];
    removed.appearance_presets = [];
    delete removed.auth.name;
    setState(removed);
    flush();
    assert.equal(evaluations, loadedEvaluations + 2);
    assert.deepEqual(
        observed()?.photos.map((photo) => photo.id),
        ["b"],
    );
    assert.deepEqual(state()?.photo_cache.photos, [{ id: "b" }]);
    assert.deepEqual(state()?.selected_emoji_ids, []);
    assert.deepEqual(state()?.selected_emojis, []);
    assert.deepEqual(state()?.appearance_presets, []);
    assert.equal(state()?.auth.name, undefined);

    const switched = structuredClone(removed);
    switched.active_account_id = "work";
    setState(switched);
    flush();
    assert.equal(evaluations, loadedEvaluations + 3);
    assert.equal(observed()?.active_account_id, "work");
    setState(structuredClone(switched));
    flush();
    assert.equal(evaluations, loadedEvaluations + 3);
    assert.equal(state(), switched);
    dispose();
});
