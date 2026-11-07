import { emojiDisplayName, photoDisplayName } from "./display-names";
import { createEffect, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { accountApi, reconcilePhotoOrder, RequestError, request, timeRemaining } from "./api";
import type { AccountApi, EmojiChoice, Settings, State } from "./api";
import { AccountMenu, Login, type Actions } from "./Accounts";
import { Duration } from "./duration";
import { createAutosave } from "./autosave";
import { createEmojiPacks } from "./emoji-packs";
import { createEmojiSearch } from "./emoji-search";
import { EmojiMedia } from "./EmojiMedia";
import { PhotoDialog } from "./PhotoDialog";
import { photoMatchMessage } from "./photo-status";
import { SortableList } from "./SortableList";
import { serverMessage, t } from "./i18n";
import { Notifications } from "./notifications";
import { createNotifications } from "./notification-center";
import { resetTilt, tilt } from "./tilt";
import {
    Button,
    Card,
    Checkbox,
    CheckboxControl,
    CheckboxInput,
    CheckboxLabel,
    Select,
    SelectContent,
    SelectItem,
    SelectLabel,
    SelectPortal,
    SelectTrigger,
    SelectValue,
    Tabs,
    TabsContent,
    TabsIndicator,
    TabsList,
    TabsTrigger,
    TextField,
    TextFieldInput,
    TextFieldLabel,
} from "./components/ui";

type AccountActions = Actions & { api: AccountApi };
type Notify = (message: string, action?: () => void) => void;
type SaveStatusValue = "idle" | "pending" | "saved" | "error";
type SaveKey = "photos" | "emojis" | "photoSettings" | "emojiSettings";
type ReportSave = (
    key: SaveKey,
    status: SaveStatusValue,
    valid: boolean,
    retry: () => void,
) => void;
function saveLabel(key: SaveKey) {
    const labels = {
        photos: "profilePhotos",
        emojis: "emojiStatus",
        photoSettings: "photoRotation",
        emojiSettings: "emojiRotation",
    } as const;
    return t(labels[key]);
}

export default function App() {
    const [state, setState] = createSignal<State>();
    const [now, setNow] = createSignal(Date.now() / 1000);
    const [operation, setOperation] = createSignal<"mutation" | "reorder">();
    const [connectionError, setConnectionError] = createSignal("");
    const [notice, setNotice] = createSignal("");
    const notifications = createNotifications();
    const [saves, setSaves] = createSignal<
        Partial<Record<SaveKey, { status: SaveStatusValue; valid: boolean; retry: () => void }>>
    >({});
    const unsaved = () =>
        Object.values(saves()).some((save) => save.status === "pending" || save.status === "error");
    const saving = () => Object.values(saves()).some((save) => save.status === "pending");
    const failed = () => {
        const keys: SaveKey[] = ["photos", "emojis", "photoSettings", "emojiSettings"];
        return keys.flatMap((key) => {
            const save = saves()[key];
            return save?.status === "error" && save.valid ? [{ key, save }] : [];
        });
    };
    const saveNotifications: Partial<Record<SaveKey, number>> = {};
    function reportSave(key: SaveKey, status: SaveStatusValue, valid: boolean, retry: () => void) {
        const previous = saves()[key];
        setSaves((current) => ({ ...current, [key]: { status, valid, retry } }));
        if (!valid && previous?.valid !== false) {
            notifications.push(t("invalidSettingsContext", { context: saveLabel(key) }));
        }
        if (status !== "error" || !valid) {
            const id = saveNotifications[key];
            if (id != null) notifications.dismiss(id);
            delete saveNotifications[key];
        } else if (previous?.status !== "error" || !previous.valid) {
            /* oxlint-disable solid/reactivity -- notifications.push stores this callback for the retry button; reactive values are read when clicked. */
            saveNotifications[key] = notifications.push(
                t("saveFailedContext", { context: saveLabel(key) }),
                () => {
                    const save = saves()[key];
                    if (save?.status === "error" && save.valid) save.retry();
                },
            );
            /* oxlint-enable solid/reactivity */
        }
    }
    let pending: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let clock: ReturnType<typeof setInterval>;
    let stopped = false;

    function backgroundError() {
        const data = state();
        if (!data?.last_error) return "";
        return serverMessage(data.last_error_info, data.last_error);
    }

    function load() {
        pending ??= request("state")
            .then((data) => {
                if (state() && data.active_account_id !== state()?.active_account_id && unsaved())
                    return;
                if (data.active_account_id !== state()?.active_account_id) {
                    setNotice("");
                }
                setState(data);
                setConnectionError("");
            })
            .catch((failure) => {
                setConnectionError(t("cannotReachCeline"));
                throw failure;
            })
            .finally(() => {
                pending = undefined;
            });
        return pending;
    }

    async function refresh() {
        await pending?.catch(() => {});
        await load();
    }

    async function poll() {
        if (!operation()) await load().catch(() => {});
        if (!stopped) timer = setTimeout(poll, 2000);
    }

    async function perform(work: () => Promise<void>, message = "", activity?: "reorder") {
        // Reordering leaves settings editable, but mutations still share one lock.
        if (operation()) return;
        setOperation(activity ?? "mutation");
        setNotice("");
        let failure: unknown;
        try {
            await pending?.catch(() => {});
            await work();
        } catch (error) {
            failure = error;
        }
        try {
            await refresh();
        } catch (error) {
            failure ??= error;
        }
        if (failure)
            notifications.push(
                failure instanceof RequestError ? failure.message : t("requestFailed"),
            );
        else setNotice(message);
        setOperation(undefined);
    }

    createEffect(connectionError, (message, previous) => {
        if (message && message !== previous) notifications.push(message);
    });
    createEffect(
        () => [state()?.active_account_id, backgroundError()] as const,
        ([, message], previous) => {
            if (
                message &&
                (message !== previous?.[1] || state()?.active_account_id !== previous?.[0])
            )
                notifications.push(message);
        },
    );

    onSettled(() => {
        void poll();
        clock = setInterval(() => setNow(Date.now() / 1000), 1000);
    });
    onCleanup(() => {
        stopped = true;
        clearTimeout(timer);
        clearInterval(clock);
    });

    return (
        <main class="my-5! bg-background text-foreground sm:my-10!">
            <header class="flex items-center justify-between gap-4">
                <h1
                    class={{
                        "m-0! text-[1.375rem]! font-bold tracking-tight": true,
                        saving: saving(),
                    }}
                >
                    Celine
                </h1>
                <Show when={state()}>
                    {(data) => (
                        <AccountMenu
                            accounts={data().accounts}
                            activeId={data().active_account_id}
                            now={now()}
                            busy={!!operation() || unsaved()}
                            unsaved={unsaved()}
                            perform={perform}
                        />
                    )}
                </Show>
            </header>
            <div class="visually-hidden" role="status" aria-live="polite">
                {saving() ? t("savingChanges") : ""}
            </div>
            <Show when={failed().length}>
                <div class="mt-4 flex flex-wrap gap-2">
                    <For each={failed()}>
                        {({ key, save }) => (
                            <Button variant="secondary" size="sm" onClick={() => save.retry()}>
                                {t("retrySaveContext", { context: saveLabel(key) })}
                            </Button>
                        )}
                    </For>
                </div>
            </Show>
            <Notifications center={notifications} />
            <Show when={notice()}>
                <p role="status">{notice()}</p>
            </Show>
            <Show when={state()} fallback={<p role="status">{t("connecting")}</p>}>
                {(data) => (
                    <Show when={data().active_account_id} keyed>
                        {(id) => (
                            <AccountWorkspace
                                api={accountApi(id)}
                                notify={notifications.push}
                                state={data()}
                                now={now()}
                                busy={!!operation()}
                                reordering={operation() === "reorder"}
                                perform={perform}
                                refresh={refresh}
                                reportSave={reportSave}
                            />
                        )}
                    </Show>
                )}
            </Show>
        </main>
    );
}

function AccountWorkspace(
    props: AccountActions & {
        notify: Notify;
        state: State;
        now: number;
        reordering: boolean;
        refresh: () => Promise<void>;
        reportSave: ReportSave;
    },
) {
    const [selectedTab, setTab] = createSignal<"photos" | "emojis">("photos");
    const premium = () => (props.state.profile?.premium ?? props.state.auth.premium) === true;
    const tab = () => (premium() ? selectedTab() : "photos");
    const photoOrder = createAutosave<string[]>(
        (ids) =>
            props.api.request("photos/order", "POST", {
                ids: reconcilePhotoOrder(
                    ids,
                    props.state.photos.map((photo) => photo.id),
                ),
            }),
        () => props.refresh(),
    );
    onCleanup(photoOrder.dispose);
    createEffect(photoOrder.status, (status) =>
        props.reportSave("photos", status, true, () => void photoOrder.retry().catch(() => {})),
    );
    onCleanup(() => props.reportSave("photos", "idle", true, () => {}));
    createEffect(
        () => [photoOrder.status(), photoOrder.draft(), props.state.photos] as const,
        ([status, draft, photos]) => {
            const ids = photos.map((photo) => photo.id);
            if (
                status === "saved" &&
                draft &&
                JSON.stringify(reconcilePhotoOrder(draft, ids)) === JSON.stringify(ids)
            )
                photoOrder.acknowledge();
        },
    );
    const emojis = createAutosave<string[]>(
        (ids) => props.api.request("emojis", "PUT", { ids }),
        () => props.refresh(),
    );
    onCleanup(emojis.dispose);
    createEffect(emojis.status, (status) =>
        props.reportSave("emojis", status, true, () => void emojis.retry().catch(() => {})),
    );
    onCleanup(() => props.reportSave("emojis", "idle", true, () => {}));
    createEffect(
        () => [emojis.status(), emojis.draft(), props.state.selected_emoji_ids] as const,
        ([status, draft, selected]) => {
            if (status === "saved" && draft && JSON.stringify(draft) === JSON.stringify(selected))
                emojis.acknowledge();
        },
    );

    return (
        <Show
            when={props.state.auth.status === "authorized"}
            fallback={
                <Login
                    api={props.api}
                    auth={props.state.auth}
                    now={props.now}
                    busy={props.busy}
                    perform={props.perform}
                />
            }
        >
            <Tabs
                class="mt-6"
                value={tab()}
                onChange={(value) => setTab(value === "emojis" ? "emojis" : "photos")}
            >
                <TabsList aria-label={t("rotationSettings")}>
                    <TabsTrigger value="photos" aria-controls="photos-panel">
                        {t("profilePhotos")}
                    </TabsTrigger>
                    <TabsTrigger value="emojis" aria-controls="emojis-panel">
                        {t("emojiStatus")}
                    </TabsTrigger>
                    <TabsIndicator />
                </TabsList>
                <div class="relative">
                    <TabsContent
                        value="photos"
                        id="photos-panel"
                        forceMount
                        inert={tab() !== "photos"}
                        aria-hidden={tab() !== "photos" ? "true" : undefined}
                        class={[
                            "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-out",
                            tab() === "photos"
                                ? "relative opacity-100 translate-y-0"
                                : "pointer-events-none invisible absolute inset-x-0 top-0 opacity-0 -translate-y-2",
                        ]}
                    >
                        <Photos
                            api={props.api}
                            notify={props.notify}
                            photos={props.state.photos}
                            photoCache={props.state.photo_cache}
                            currentPhotoId={
                                props.state.applied_settings ? props.state.current_photo_id : null
                            }
                            busy={props.busy}
                            perform={props.perform}
                            refresh={props.refresh}
                            autosave={photoOrder}
                        />
                        <Rotation
                            api={props.api}
                            target="photo"
                            settings={props.state.settings}
                            count={props.state.photos.length}
                            next={props.state.next_rotation_at}
                            now={props.now}
                            busy={props.busy && !props.reordering}
                            locked={props.busy}
                            perform={props.perform}
                            refresh={props.refresh}
                            applied={props.state.applied_settings}
                            beforeAction={photoOrder.flush}
                            reportSave={props.reportSave}
                        />
                    </TabsContent>
                    <TabsContent
                        value="emojis"
                        id="emojis-panel"
                        forceMount
                        inert={tab() !== "emojis"}
                        aria-hidden={tab() !== "emojis" ? "true" : undefined}
                        class={[
                            "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-out",
                            tab() === "emojis"
                                ? "relative opacity-100 translate-y-0"
                                : "pointer-events-none invisible absolute inset-x-0 top-0 opacity-0 translate-y-2",
                        ]}
                    >
                        <EmojiPicker
                            api={props.api}
                            notify={props.notify}
                            selected={props.state.selected_emoji_ids}
                            selectedEmojis={props.state.selected_emojis}
                            premium={premium()}
                            busy={props.busy}
                            perform={props.perform}
                            autosave={emojis}
                        />
                        <Show when={premium()}>
                            <Rotation
                                api={props.api}
                                target="emoji"
                                settings={props.state.emoji_settings}
                                count={(emojis.draft() ?? props.state.selected_emoji_ids).length}
                                next={props.state.next_emoji_rotation_at}
                                now={props.now}
                                busy={props.busy && !props.reordering}
                                locked={props.busy}
                                perform={props.perform}
                                refresh={props.refresh}
                                applied={props.state.applied_emoji_settings}
                                beforeAction={emojis.flush}
                                reportSave={props.reportSave}
                            />
                        </Show>
                    </TabsContent>
                </div>
            </Tabs>
        </Show>
    );
}

function Photos(
    props: AccountActions & {
        notify: Notify;
        photos: State["photos"];
        photoCache: State["photo_cache"];
        currentPhotoId: string | null;
        refresh: () => Promise<void>;
        autosave: ReturnType<typeof createAutosave<string[]>>;
    },
) {
    const photos = () => {
        const ids = props.autosave.draft();
        if (!ids) return props.photos;
        const byId = new Map(props.photos.map((photo) => [photo.id, photo]));
        return reconcilePhotoOrder(
            ids,
            props.photos.map((photo) => photo.id),
        ).map((id) => byId.get(id)!);
    };
    let input!: HTMLInputElement;
    // Only the initial empty library opens the picker; later updates preserve the user’s choice.
    const [pickerOpen, setPickerOpen] = createSignal(untrack(() => props.photos.length === 0));
    const [draggingFiles, setDraggingFiles] = createSignal(false);
    const [selecting, setSelecting] = createSignal(false);
    const [uploading, setUploading] = createSignal(false);
    const [photoDialog, setPhotoDialog] = createSignal<{
        photo: State["photos"][number];
        edit: boolean;
    }>();
    let editButton: HTMLButtonElement | undefined;
    const [refreshingHistory, setRefreshingHistory] = createSignal(false);
    let pickerSummary!: HTMLElement;

    async function refreshHistory() {
        setRefreshingHistory(true);
        try {
            await props.api.request("photos/history/refresh", "POST");
            await props.refresh();
        } catch (failure) {
            props.notify(failure instanceof RequestError ? failure.message : t("cannotLoadPhotos"));
        } finally {
            setRefreshingHistory(false);
        }
    }

    function closePicker() {
        setPickerOpen(false);
        pickerSummary.focus();
    }

    async function togglePhoto(id: string) {
        if (props.busy || selecting()) return;
        const selected = props.photos.find((photo) => photo.telegram_id === id);
        setSelecting(true);
        try {
            // oxlint-disable-next-line solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation.
            await props.perform(async () => {
                await props.autosave.flush();
                await (selected
                    ? props.api.request(`photos/${encodeURIComponent(selected.id)}`, "DELETE")
                    : props.api.request("photos/history", "POST", { id }));
            });
        } finally {
            setSelecting(false);
        }
    }

    async function upload(files: File[]) {
        if (!files.length || props.busy) return;
        setUploading(true);
        try {
            // oxlint-disable-next-line solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation.
            await props.perform(async () => {
                await props.autosave.flush();
                for (const file of files) {
                    const form = new FormData();
                    form.append("file", file);
                    await props.api.request("photos", "POST", form);
                }
            });
        } finally {
            setUploading(false);
        }
    }

    function reorder(ids: string[]) {
        props.autosave.edit(ids);
    }

    function remove(id: string) {
        // oxlint-disable-next-line solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation.
        void props.perform(async () => {
            await props.autosave.flush();
            await props.api.request(`photos/${encodeURIComponent(id)}`, "DELETE");
        });
    }

    return (
        <section
            aria-label={t("profilePhotos")}
            class={{ "photo-drop-active": draggingFiles() }}
            onDragOver={(event) => {
                if (!event.dataTransfer?.types.includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = props.busy ? "none" : "copy";
                setDraggingFiles(!props.busy);
            }}
            onDragLeave={(event) => {
                if (
                    !(event.relatedTarget instanceof Node) ||
                    !event.currentTarget.contains(event.relatedTarget)
                )
                    setDraggingFiles(false);
            }}
            onDrop={(event) => {
                if (!event.dataTransfer?.types.includes("Files")) return;
                event.preventDefault();
                setDraggingFiles(false);
                void upload(Array.from(event.dataTransfer.files));
            }}
        >
            <input
                type="file"
                accept="image/jpeg,image/png"
                multiple
                disabled={props.busy}
                class="visually-hidden"
                aria-label={t("uploadPhotos")}
                tabindex="-1"
                ref={(element) => {
                    input = element;
                }}
                onChange={(event) => {
                    if (event.currentTarget.files)
                        void upload(Array.from(event.currentTarget.files));
                    event.currentTarget.value = "";
                }}
            />
            <Show when={uploading()}>
                <p role="status">{t("savingPhotos")}</p>
            </Show>
            <SortableList
                kind="photo"
                busy={props.busy}
                reorder={reorder}
                items={photos().map((photo) => ({
                    id: photo.id,
                    label: photoDisplayName(photo),
                    imageUrl: props.api.selectedPhotoUrl(photo),
                    reorderLabel: photo.generated_name ? t("reorderTelegramPhoto") : undefined,
                    removeLabel: photo.generated_name ? t("removeTelegramPhoto") : undefined,
                    badge: photoMatchMessage(photo, props.photoCache),
                    current: photo.id === props.currentPhotoId,
                }))}
                edit={(id, button) => {
                    editButton = button;
                    setPhotoDialog({
                        photo: props.photos.find((photo) => photo.id === id)!,
                        edit: true,
                    });
                }}
                preview={(id, button) => {
                    editButton = button;
                    setPhotoDialog({
                        photo: props.photos.find((photo) => photo.id === id)!,
                        edit: false,
                    });
                }}
                remove={remove}
                trailing={
                    <button
                        type="button"
                        class="photo-add"
                        disabled={props.busy}
                        aria-label={t("uploadPhotos")}
                        title={t("uploadPhotos")}
                        onClick={() => input.click()}
                    >
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                    </button>
                }
            />
            <Show when={photoDialog()} keyed>
                {(dialog) => (
                    <PhotoDialog
                        api={props.api}
                        photo={dialog.photo}
                        edit={dialog.edit}
                        refresh={props.refresh}
                        close={() => {
                            setPhotoDialog(undefined);
                            queueMicrotask(() => editButton?.focus());
                        }}
                    />
                )}
            </Show>
            <div
                id="photo-browser"
                class="photo-browser"
                onKeyDown={(event) => {
                    if (event.key === "Escape" && pickerOpen()) {
                        event.preventDefault();
                        closePicker();
                    }
                }}
            >
                <div class="flex items-center gap-2">
                    <details
                        open={pickerOpen()}
                        onToggle={(event) => setPickerOpen(event.currentTarget.open)}
                    >
                        <summary
                            aria-controls="photo-history"
                            ref={(element) => {
                                pickerSummary = element;
                            }}
                        >
                            {t("selectExistingPhotos")}
                        </summary>
                    </details>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("refreshPhotoCache")}
                        title={t("refreshPhotoCache")}
                        disabled={refreshingHistory() || props.photoCache.status === "refreshing"}
                        onClick={() => void refreshHistory()}
                    >
                        <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M20 11a8 8 0 0 0-14-5L4 8m0-4v4h4M4 13a8 8 0 0 0 14 5l2-2m0 4v-4h-4" />
                        </svg>
                    </Button>
                </div>
                <Show when={pickerOpen()}>
                    <div
                        id="photo-history"
                        class="photo-history"
                        role="region"
                        aria-label={t("telegramProfilePhotos")}
                        aria-busy={props.photoCache.status === "refreshing" ? "true" : "false"}
                    >
                        <Show when={props.photoCache.status !== "ready"}>
                            <p class="hint" role="status">
                                {t(
                                    props.photoCache.status === "refreshing"
                                        ? "photoCacheRefreshing"
                                        : "photoCacheError",
                                )}
                            </p>
                        </Show>
                        <Show
                            when={props.photoCache.photos.length}
                            fallback={
                                <Show when={props.photoCache.status === "ready"}>
                                    <p class="hint">{t("noTelegramPhotos")}</p>
                                </Show>
                            }
                        >
                            <div class="photo-choices">
                                <For each={props.photoCache.photos.map((photo) => photo.id)}>
                                    {(id, index) => (
                                        <PhotoChoice
                                            url={props.api.photoHistoryUrl(id)}
                                            label={t("includeTelegramPhoto", {
                                                number: index() + 1,
                                            })}
                                            checked={props.photos.some(
                                                (item) => item.telegram_id === id,
                                            )}
                                            disabled={props.busy || selecting()}
                                            toggle={() => void togglePhoto(id)}
                                        />
                                    )}
                                </For>
                            </div>
                        </Show>
                    </div>
                    <p class="hint">{t("photoSelectionHint")}</p>
                </Show>
            </div>
        </section>
    );
}

function PhotoChoice(props: {
    url: string;
    label: string;
    checked: boolean;
    disabled: boolean;
    toggle: () => void;
}) {
    const [loading, setLoading] = createSignal(true);

    return (
        <label
            class="photo-choice"
            onPointerMove={tilt}
            onPointerLeave={resetTilt}
            onPointerCancel={resetTilt}
        >
            <input
                class="visually-hidden"
                type="checkbox"
                aria-label={props.label}
                checked={props.checked}
                disabled={props.disabled}
                onChange={(event) => {
                    event.currentTarget.checked = props.checked;
                    props.toggle();
                }}
            />
            <Show when={loading()}>
                <span class="photo-skeleton" aria-hidden="true" />
            </Show>
            <img
                class={{ "photo-loading": loading() }}
                src={props.url}
                alt=""
                loading="lazy"
                draggable="false"
                onLoad={() => setLoading(false)}
                onError={() => setLoading(false)}
            />
        </label>
    );
}

function DurationField(props: {
    id: string;
    label: string;
    seconds: number;
    minimum: number;
    maximum?: number;
    disabled: boolean;
    change: (seconds: number) => void;
    invalid?: () => void;
    isInvalid?: boolean;
    errorId?: string;
}) {
    // Choose the initial display unit once; edits and server refreshes must not reset it.
    const [unit, setUnit] = createSignal(untrack(() => Duration.unitFor(props.seconds)));
    const units = Duration.units.map((item) => ({
        value: String(item.seconds),
        label: t(item.label),
    }));

    return (
        <TextField
            class="flex flex-wrap items-center gap-x-4 gap-y-2"
            value={Number.isFinite(props.seconds) ? String(props.seconds / unit()) : ""}
            disabled={props.disabled}
            required
            validationState={props.isInvalid ? "invalid" : "valid"}
        >
            <TextFieldLabel class="min-w-20 text-foreground">{props.label}</TextFieldLabel>
            <div class="flex min-w-0 flex-1 items-center gap-2">
                <TextFieldInput
                    class="w-28 flex-[0_1_7rem] rounded-lg bg-background tabular-nums"
                    id={props.id}
                    type="number"
                    inputmode="decimal"
                    step="any"
                    min={props.minimum / unit()}
                    max={props.maximum == null ? undefined : props.maximum / unit()}
                    onInvalid={props.invalid}
                    aria-describedby={props.isInvalid ? props.errorId : undefined}
                    onInput={(event) =>
                        props.change(Duration.seconds(event.currentTarget.valueAsNumber, unit()))
                    }
                />
                <Select
                    class="w-auto"
                    options={units}
                    optionValue="value"
                    optionTextValue="label"
                    value={units.find((item) => Number(item.value) === unit())}
                    onChange={(item) => item && setUnit(Number(item.value))}
                    disabled={props.disabled}
                    disallowEmptySelection
                    itemComponent={(item) => (
                        <SelectItem item={item.item}>{item.item.rawValue.label}</SelectItem>
                    )}
                >
                    <SelectTrigger aria-label={t("durationUnit", { label: props.label })}>
                        <SelectValue<(typeof units)[number]>>
                            {(state) => state.selectedOption()?.label}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectPortal>
                        <SelectContent />
                    </SelectPortal>
                </Select>
            </div>
        </TextField>
    );
}

function Rotation(
    props: AccountActions & {
        target: "photo" | "emoji";
        settings: Settings;
        applied: Settings | null;
        count: number;
        next: number | null;
        now: number;
        locked: boolean;
        refresh: () => Promise<void>;
        beforeAction?: () => Promise<void>;
        reportSave: ReportSave;
    },
) {
    let jitterDetails!: HTMLDetailsElement;
    const endpoint = () => (props.target === "photo" ? "settings" : "emojis/settings");
    const fieldId = (field: string) => `${props.target}-${field}`;
    const jitterModes = [
        { value: "auto", label: t("automaticJitter") },
        { value: "custom", label: t("custom") },
    ];
    const autosave = createAutosave<Settings>(
        (value) =>
            props.api.request(endpoint(), "PUT", { ...value, enabled: props.settings.enabled }),
        () => props.refresh(),
    );
    onCleanup(autosave.dispose);
    const saveKey = () => (props.target === "photo" ? "photoSettings" : "emojiSettings");
    const settings = () => autosave.draft() ?? props.settings;
    const intervalInvalid = () =>
        !Number.isFinite(settings().interval_secs) || settings().interval_secs < 1;
    const jitterInvalid = () =>
        settings().jitter_secs != null &&
        (!Number.isFinite(settings().jitter_secs) ||
            settings().jitter_secs! < 0 ||
            settings().jitter_secs! >= settings().interval_secs);
    const valid = () => !intervalInvalid() && !jitterInvalid();
    createEffect(jitterInvalid, (invalid) => {
        if (invalid) jitterDetails.open = true;
    });
    createEffect(
        () => [autosave.status(), valid()] as const,
        ([status, isValid]) =>
            props.reportSave(
                saveKey(),
                status,
                isValid,
                () => void autosave.retry().catch(() => {}),
            ),
    );
    onCleanup(() => props.reportSave(saveKey(), "idle", true, () => {}));
    const configEqual = (a: Settings, b: Settings) =>
        a.mode === b.mode && a.interval_secs === b.interval_secs && a.jitter_secs === b.jitter_secs;
    createEffect(
        () => [autosave.status(), autosave.draft(), props.settings] as const,
        ([status, draft, saved]) => {
            if (status === "saved" && draft && configEqual(draft, saved)) autosave.acknowledge();
        },
    );

    function edit(change: Partial<Settings>) {
        const value = { ...settings(), ...change };
        const isValid =
            Number.isFinite(value.interval_secs) &&
            value.interval_secs >= 1 &&
            (value.jitter_secs == null ||
                (Number.isFinite(value.jitter_secs) &&
                    value.jitter_secs >= 0 &&
                    value.jitter_secs < value.interval_secs));
        autosave.edit(value, isValid);
    }

    function action(name: "apply" | "start" | "stop") {
        // oxlint-disable-next-line solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation.
        void props.perform(async () => {
            if (name !== "stop") {
                await autosave.flush();
                await props.beforeAction?.();
            }
            await props.api.request(`${endpoint()}/${name}`, "POST");
        });
    }

    return (
        <section aria-labelledby={fieldId("rotation-title")}>
            <Card class="gap-0 rounded-2xl p-4 sm:p-5">
                <h2
                    class="m-0! text-base! font-semibold tracking-tight"
                    id={fieldId("rotation-title")}
                >
                    {props.target === "photo" ? t("photoRotation") : t("emojiRotation")}
                </h2>
                <form
                    class="my-5! grid gap-4!"
                    onSubmit={(event) => {
                        event.preventDefault();
                    }}
                >
                    <Checkbox
                        class="flex min-h-10 items-center gap-3 self-start justify-self-start"
                        checked={settings().mode === "random"}
                        disabled={props.busy}
                        onChange={(checked) => edit({ mode: checked ? "random" : "ordered" })}
                    >
                        <CheckboxLabel class="cursor-pointer font-semibold">
                            {t("randomOrder")}
                        </CheckboxLabel>
                        <CheckboxInput />
                        <CheckboxControl class="size-5 cursor-pointer" />
                    </Checkbox>
                    <DurationField
                        id={fieldId("interval")}
                        label={t("delay")}
                        seconds={settings().interval_secs}
                        minimum={1}
                        disabled={props.busy}
                        isInvalid={intervalInvalid()}
                        errorId={fieldId("invalid-settings")}
                        change={(seconds) => edit({ interval_secs: seconds })}
                    />
                    <details
                        class="rounded-xl bg-muted/60 px-4 py-2 text-sm"
                        ref={(element) => {
                            jitterDetails = element;
                        }}
                    >
                        <summary
                            class="group/summary relative cursor-pointer py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            aria-label={
                                settings().jitter_secs == null
                                    ? t("jitterAutomaticLabel")
                                    : t("jitterCustomLabel")
                            }
                            aria-describedby={fieldId("jitter-help")}
                        >
                            {t("jitter")}
                            <span class="group/help ms-1 inline-grid size-5 place-items-center rounded-full bg-surface text-xs text-muted-foreground">
                                <span aria-hidden="true">?</span>
                                <span
                                    class="invisible absolute bottom-full inset-s-0 z-10 w-64 max-w-full rounded-lg bg-foreground px-3 py-2 text-sm font-normal text-background shadow-lg group-focus-visible/summary:visible group-hover/help:visible"
                                    id={fieldId("jitter-help")}
                                    role="tooltip"
                                >
                                    {t("jitterHelp")}
                                </span>
                            </span>
                            <span class="ms-3 text-sm font-normal text-muted-foreground">
                                {settings().jitter_secs == null ? t("automatic") : t("custom")}
                            </span>
                        </summary>
                        <div class="my-2 grid gap-2">
                            <Select
                                options={jitterModes}
                                optionValue="value"
                                optionTextValue="label"
                                value={
                                    settings().jitter_secs == null ? jitterModes[0] : jitterModes[1]
                                }
                                disabled={props.busy}
                                disallowEmptySelection
                                onChange={(item) => {
                                    if (item)
                                        edit({
                                            jitter_secs:
                                                item.value === "auto"
                                                    ? null
                                                    : Duration.defaultJitter(
                                                          settings().interval_secs,
                                                      ),
                                        });
                                }}
                                itemComponent={(item) => (
                                    <SelectItem item={item.item}>
                                        {item.item.rawValue.label}
                                    </SelectItem>
                                )}
                            >
                                <SelectLabel>{t("jitterSetting")}</SelectLabel>
                                <SelectTrigger id={fieldId("jitter-mode")}>
                                    <SelectValue<(typeof jitterModes)[number]>>
                                        {(state) => state.selectedOption()?.label}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectPortal>
                                    <SelectContent />
                                </SelectPortal>
                            </Select>
                            <Show when={settings().jitter_secs != null}>
                                <DurationField
                                    id={fieldId("jitter")}
                                    label={t("customJitter")}
                                    seconds={settings().jitter_secs ?? 0}
                                    minimum={0}
                                    maximum={settings().interval_secs - 1}
                                    disabled={props.busy}
                                    isInvalid={jitterInvalid()}
                                    errorId={fieldId("invalid-settings")}
                                    change={(seconds) => edit({ jitter_secs: seconds })}
                                    invalid={() => {
                                        jitterDetails.open = true;
                                    }}
                                />
                            </Show>
                        </div>
                    </details>
                    <span id={fieldId("invalid-settings")} class="visually-hidden">
                        {t("invalidSettings")}
                    </span>
                    <div class="flex flex-wrap items-center gap-2">
                        <Show
                            when={props.settings.enabled}
                            fallback={
                                <Button
                                    disabled={props.locked || props.count === 0 || !valid()}
                                    onClick={() => action("start")}
                                >
                                    {t("startRotation")}
                                </Button>
                            }
                        >
                            <Button
                                disabled={
                                    props.locked ||
                                    !valid() ||
                                    !props.applied ||
                                    configEqual(settings(), props.applied)
                                }
                                onClick={() => action("apply")}
                            >
                                {t("applySettings")}
                            </Button>
                            <Button
                                variant="secondary"
                                disabled={props.locked}
                                onClick={() => action("stop")}
                            >
                                {t("stopRotation")}
                            </Button>
                        </Show>
                    </div>
                </form>
                <p class="m-0 text-sm text-muted-foreground tabular-nums" role="status">
                    {props.settings.enabled
                        ? props.next
                            ? t(props.target === "photo" ? "nextPhoto" : "nextEmoji", {
                                  time: timeRemaining(props.next, props.now),
                              })
                            : t("running")
                        : t("stopped")}
                </p>
            </Card>
        </section>
    );
}

function emojiSource(emoji: EmojiChoice): string {
    if (emoji.source_kind === "recent") return t("emojiSourceRecent");
    if (emoji.source_kind === "default") return t("emojiSourceDefault");
    if (emoji.source_kind === "search") return t("emojiSearchResults");
    return emoji.source;
}

function EmojiChoices(props: {
    choices: EmojiChoice[];
    api: AccountApi;
    selected: string[];
    busy: boolean;
    toggle: (id: string) => void;
}) {
    return (
        <div class="emojis">
            <For each={props.choices}>
                {(emoji) => (
                    <label
                        class="emoji-choice"
                        title={emojiSource(emoji)}
                        onPointerMove={tilt}
                        onPointerLeave={resetTilt}
                        onPointerCancel={resetTilt}
                    >
                        <input
                            type="checkbox"
                            aria-label={`${emojiDisplayName(emoji.label)} (${emojiSource(emoji)})`}
                            checked={props.selected.includes(emoji.id)}
                            disabled={props.busy}
                            onChange={() => props.toggle(emoji.id)}
                        />
                        <span class="emoji-preview" aria-hidden="true">
                            <EmojiMedia
                                url={props.api.emojiMediaUrl(emoji.id)}
                                label={emojiDisplayName(emoji.label)}
                                textColor={emoji.text_color}
                            />
                        </span>
                    </label>
                )}
            </For>
        </div>
    );
}

function EmojiSearchMore(props: { loadMore: () => void }) {
    let sentinel!: HTMLDivElement;
    onSettled(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) props.loadMore();
            },
            { root: sentinel.parentElement, rootMargin: "0px 0px 160px" },
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    });
    return (
        <div
            class="h-px"
            aria-hidden="true"
            ref={(element) => {
                sentinel = element;
            }}
        />
    );
}

function EmojiPicker(
    props: AccountActions & {
        notify: Notify;
        selected: string[];
        selectedEmojis: EmojiChoice[];
        premium: boolean;
        autosave: ReturnType<typeof createAutosave<string[]>>;
    },
) {
    // The keyed account workspace owns this catalog for the lifetime of its account API.
    const packs = untrack(() => createEmojiPacks(props.api));
    const search = untrack(() => createEmojiSearch(props.api));
    const [pickerOpen, setPickerOpen] = createSignal(false);
    let addButton!: HTMLButtonElement;
    const selected = () => props.autosave.draft() ?? props.selected;

    createEffect(
        () => props.premium && pickerOpen(),
        (open, wasOpen) => {
            if (open && !wasOpen) untrack(() => void packs.select());
        },
    );
    createEffect(
        () => [packs.activeId, packs.active?.error] as const,
        ([id, message], previous) => {
            if (message && (id !== previous?.[0] || message !== previous?.[1])) {
                props.notify(message, () => void packs.select(id));
            }
        },
    );

    function save(ids: string[]) {
        props.autosave.edit(ids);
    }

    function toggle(id: string) {
        save(
            selected().includes(id)
                ? selected().filter((item) => item !== id)
                : [...selected(), id],
        );
    }

    function closePicker() {
        search.setQuery("");
        setPickerOpen(false);
        addButton.focus();
    }

    function selectPack(id: string) {
        search.setQuery("");
        void packs.select(id);
    }

    onCleanup(search.dispose);

    return (
        <section aria-label={t("emojiStatus")}>
            <Show when={props.premium}>
                <SortableList
                    kind="emoji"
                    busy={props.busy}
                    reorder={save}
                    remove={toggle}
                    items={selected().map((id) => {
                        const choice =
                            packs.find(id) ??
                            search.find(id) ??
                            props.selectedEmojis.find((emoji) => emoji.id === id);
                        return {
                            id,
                            label: emojiDisplayName(choice?.label ?? id),
                            mediaUrl: props.api.emojiMediaUrl(id),
                            textColor: choice?.text_color,
                        };
                    })}
                    trailing={
                        <button
                            type="button"
                            class="emoji-add"
                            aria-label={t("addEmoji")}
                            aria-expanded={pickerOpen() ? "true" : "false"}
                            aria-controls="emoji-browser"
                            ref={(element) => {
                                addButton = element;
                            }}
                            onClick={() => (pickerOpen() ? closePicker() : setPickerOpen(true))}
                        >
                            <svg aria-hidden="true" viewBox="0 0 24 24">
                                <path d="M12 5v14M5 12h14" />
                            </svg>
                        </button>
                    }
                />
                <div
                    id="emoji-browser"
                    class="emoji-browser"
                    hidden={!pickerOpen()}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            if (search.query) search.setQuery("");
                            else closePicker();
                        }
                    }}
                >
                    <TextField class="mb-3">
                        <TextFieldLabel class="visually-hidden">{t("searchEmoji")}</TextFieldLabel>
                        <TextFieldInput
                            type="search"
                            placeholder={t("searchEmoji")}
                            value={search.query}
                            onInput={(event) => search.setQuery(event.currentTarget.value)}
                        />
                    </TextField>
                    <nav class="emoji-packs" aria-label={t("emojiPacks")}>
                        <button
                            type="button"
                            aria-label={t("recentDefault")}
                            title={t("recentDefault")}
                            aria-pressed={
                                !search.query.trim() && packs.activeId === "" ? "true" : "false"
                            }
                            aria-controls="emoji-pack-choices"
                            onClick={() => selectPack("")}
                        >
                            <svg class="pack-glyph" aria-hidden="true" viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="8" />
                                <path d="M12 7v5l3 2" />
                            </svg>
                        </button>
                        <For each={packs.sets}>
                            {(set) => (
                                <button
                                    type="button"
                                    aria-label={set.title}
                                    title={set.title}
                                    aria-pressed={
                                        !search.query.trim() && packs.activeId === set.id
                                            ? "true"
                                            : "false"
                                    }
                                    aria-controls="emoji-pack-choices"
                                    onClick={() => selectPack(set.id)}
                                >
                                    <span aria-hidden="true">
                                        <EmojiMedia
                                            url={set.cover_url}
                                            label={set.title}
                                            textColor={set.text_color}
                                            fallback={
                                                <svg class="pack-glyph" viewBox="0 0 24 24">
                                                    <rect
                                                        x="5"
                                                        y="3"
                                                        width="14"
                                                        height="18"
                                                        rx="3"
                                                    />
                                                    <path d="M8 8h8M8 12h8M8 16h4" />
                                                </svg>
                                            }
                                        />
                                    </span>
                                </button>
                            )}
                        </For>
                        <Show when={!packs.sets.length && (!packs.active || packs.active.loading)}>
                            <For each={[0, 1, 2, 3, 4, 5]}>
                                {() => (
                                    <span class="pack-skeleton" aria-hidden="true">
                                        <span class="emoji-skeleton" />
                                    </span>
                                )}
                            </For>
                        </Show>
                    </nav>
                    <div
                        id="emoji-pack-choices"
                        role="region"
                        aria-labelledby="emoji-pack-title"
                        aria-busy={
                            (search.query.trim() ? search.state.loading : packs.active?.loading)
                                ? "true"
                                : "false"
                        }
                    >
                        <Show when={!search.query.trim()}>
                            <div class="flex items-center justify-between gap-2">
                                <h2 id="emoji-pack-title" class="text-base">
                                    {packs.title}
                                </h2>
                                <Show when={!packs.activeId}>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        class="aria-disabled:opacity-55"
                                        aria-disabled={packs.active?.loading ? "true" : undefined}
                                        onClick={() => void packs.select("")}
                                    >
                                        {t("refreshEmojiStatuses")}
                                    </Button>
                                </Show>
                            </div>
                            <Show when={!packs.active || packs.active.loading}>
                                <p class="visually-hidden" role="status">
                                    {t("loadingEmoji")}
                                </p>
                                <div class="emojis" aria-hidden="true">
                                    <For
                                        each={Array.from(
                                            { length: Math.min(packs.count || 24, 36) },
                                            (_, index) => index,
                                        )}
                                    >
                                        {() => (
                                            <span class="emoji-preview">
                                                <span class="emoji-skeleton" />
                                            </span>
                                        )}
                                    </For>
                                </div>
                            </Show>
                            <Show when={packs.active?.error}>
                                <button type="button" onClick={() => void packs.select()}>
                                    {t("retry")}
                                </button>
                            </Show>
                            <Show when={packs.active?.choices}>
                                <For each={packs.groups}>
                                    {(group) => (
                                        <section>
                                            <Show when={group.kind !== "pack"}>
                                                <h3 class="mt-4 mb-1 text-sm font-semibold text-muted-foreground">
                                                    {t(
                                                        group.kind === "recent"
                                                            ? "recentEmojiStatuses"
                                                            : "suggestedEmojiStatuses",
                                                    )}
                                                </h3>
                                            </Show>
                                            <Show
                                                when={group.choices.length}
                                                fallback={
                                                    <p class="hint">
                                                        {t(
                                                            group.kind === "recent"
                                                                ? "emptyRecentEmojiStatuses"
                                                                : "emptyEmojiPack",
                                                        )}
                                                    </p>
                                                }
                                            >
                                                <EmojiChoices
                                                    choices={group.choices}
                                                    api={props.api}
                                                    selected={selected()}
                                                    busy={props.busy}
                                                    toggle={toggle}
                                                />
                                            </Show>
                                        </section>
                                    )}
                                </For>
                            </Show>
                        </Show>
                        <Show when={search.query.trim()}>
                            <h2 id="emoji-pack-title" class="text-base">
                                {t("emojiSearchResults")}
                            </h2>
                            <Show when={search.state.choices.length}>
                                <EmojiChoices
                                    choices={search.state.choices}
                                    api={props.api}
                                    selected={selected()}
                                    busy={props.busy}
                                    toggle={toggle}
                                />
                            </Show>
                            <Show when={search.state.loading}>
                                <p class="hint" role="status">
                                    {t("loadingEmoji")}
                                </p>
                            </Show>
                            <Show when={search.state.error}>
                                <p class="hint" role="status">
                                    {search.state.error}
                                </p>
                                <Button variant="secondary" size="sm" onClick={search.retry}>
                                    {t("retry")}
                                </Button>
                            </Show>
                            <Show
                                when={
                                    !search.state.loading &&
                                    !search.state.error &&
                                    search.state.nextOffset == null &&
                                    !search.state.choices.length
                                }
                            >
                                <p class="hint" role="status">
                                    {t("emojiSearchEmpty")}
                                </p>
                            </Show>
                            <Show
                                when={
                                    search.state.nextOffset != null &&
                                    !search.state.loading &&
                                    !search.state.error
                                }
                            >
                                <EmojiSearchMore loadMore={search.loadMore} />
                            </Show>
                        </Show>
                    </div>
                </div>
            </Show>
        </section>
    );
}
