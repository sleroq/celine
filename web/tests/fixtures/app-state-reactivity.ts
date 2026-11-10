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
    last_error_info: { code: "request_failed", params: {} },
};

createRoot((dispose) => {
    const [state, setState] = createAppState();
    let photoEvaluations = 0;
    let settingsEvaluations = 0;
    let observedPhotos: State["photos"] | undefined;
    createEffect(
        () => {
            photoEvaluations++;
            return state()?.photos;
        },
        (photos) => {
            observedPhotos = photos;
        },
    );
    createEffect(
        () => {
            settingsEvaluations++;
            return state()?.settings;
        },
        () => {},
    );
    flush();
    assert.equal(state(), undefined);
    setState(initial);
    flush();
    assert.deepEqual(state(), initial);
    const accountState = state()!;
    const loadedPhotos = photoEvaluations;
    const loadedSettings = settingsEvaluations;
    const photos = state()!.photos;
    const secondPhoto = photos[1];
    const account = state()!.accounts[0];
    const selectedEmoji = state()!.selected_emojis[0];
    const historyPhoto = state()!.photo_cache.photos[1];

    setState(structuredClone(initial));
    flush();
    assert.equal(photoEvaluations, loadedPhotos);
    assert.equal(settingsEvaluations, loadedSettings);
    assert.equal(state()?.photos, photos);

    const unrelated = structuredClone(initial);
    unrelated.last_error = "Connection failed";
    setState(unrelated);
    flush();
    assert.equal(state()?.last_error, "Connection failed");
    assert.equal(photoEvaluations, loadedPhotos);
    assert.equal(settingsEvaluations, loadedSettings);
    assert.equal(state()?.photos, photos);

    // Replacing a field must not mutate server values retained by editor drafts.
    const retainedSettings = state()!.settings;
    const retainedPreset = state()!.appearance_presets[0];
    const retainedPhoto = state()!.photos[0];
    const draft = { ...retainedSettings, interval_secs: 120 };
    const changed = structuredClone(initial);
    changed.photos[0]!.name = "Updated";
    changed.settings.interval_secs = 90;
    changed.appearance_presets[0]!.profile!.color = 2;
    setState(changed);
    flush();
    assert.equal(photoEvaluations, loadedPhotos + 1);
    assert.equal(settingsEvaluations, loadedSettings + 1);
    assert.equal(state()?.photos[0]?.name, "Updated");
    assert.equal(state(), accountState);
    assert.equal(accountState.settings.interval_secs, 90);
    assert.equal(retainedPhoto?.name, "a");
    assert.equal(retainedSettings.interval_secs, 60);
    assert.equal(retainedPreset?.profile?.color, 1);
    assert.equal(initial.photos[0]?.name, "a");
    assert.equal(initial.settings.interval_secs, 60);
    assert.equal(draft.interval_secs, 120);
    assert.equal(state()?.photos[1], secondPhoto);
    assert.equal(state()?.accounts[0], account);
    assert.equal(state()?.selected_emojis[0], selectedEmoji);

    const reordered = structuredClone(changed);
    reordered.photos.reverse();
    setState(reordered);
    flush();
    assert.equal(state()?.photos[0], secondPhoto);
    assert.equal(settingsEvaluations, loadedSettings + 1);

    const removed = structuredClone(changed);
    removed.photos.splice(0, 1);
    removed.photo_cache.photos.splice(0, 1);
    removed.selected_emoji_ids = [];
    removed.selected_emojis = [];
    removed.appearance_presets = [];
    delete removed.auth.name;
    delete removed.last_error_info;
    setState(removed);
    flush();
    assert.deepEqual(
        observedPhotos?.map((photo) => photo.id),
        ["b"],
    );
    assert.equal(state()?.photos[0], secondPhoto);
    assert.equal(state()?.photo_cache.photos[0], historyPhoto);
    assert.deepEqual(state()?.selected_emoji_ids, []);
    assert.deepEqual(state()?.selected_emojis, []);
    assert.deepEqual(state()?.appearance_presets, []);
    assert.equal(state()?.auth.name, undefined);
    assert.equal(Object.hasOwn(state()!, "last_error_info"), false);

    const switched = structuredClone(removed);
    switched.active_account_id = "work";
    switched.settings.interval_secs = 300;
    setState(switched);
    flush();
    assert.notEqual(state(), accountState);
    assert.equal(accountState.active_account_id, "personal");
    assert.equal(accountState.settings.interval_secs, 90);
    assert.equal(state()?.settings.interval_secs, 300);
    assert.equal(state()?.active_account_id, "work");
    assert.notEqual(state()?.photos[0], secondPhoto);
    const switchedPhotos = photoEvaluations;
    const switchedSettings = settingsEvaluations;
    const switchedState = state();
    setState(structuredClone(switched));
    flush();
    assert.equal(photoEvaluations, switchedPhotos);
    assert.equal(settingsEvaluations, switchedSettings);
    assert.equal(state(), switchedState);
    dispose();
});
