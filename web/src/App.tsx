import { createEffect, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { createAppState } from "./app-state";
import { accountApi, RequestError, request } from "./api";
import { AccountMenu } from "./Accounts";
import { AccountWorkspace } from "./AccountWorkspace";
import type { SaveKey, SaveStatusValue } from "./save-status";
import { serverMessage, t } from "./i18n";
import { Notifications } from "./notifications";
import { createNotifications } from "./notification-center";
import { Button } from "./components/ui";

function saveLabel(key: SaveKey) {
    const labels = {
        photos: "profilePhotos",
        emojis: "emojiStatus",
        photoSettings: "photoRotation",
        emojiSettings: "emojiRotation",
        appearanceSettings: "appearanceRotation",
        appearancePresets: "appearancePresets",
    } as const;
    return t(labels[key]);
}

export default function App() {
    const [state, setState] = createAppState();
    const [now, setNow] = createSignal(Date.now() / 1000);
    const [operation, setOperation] = createSignal<"mutation" | "reorder">();
    const [connectionError, setConnectionError] = createSignal("");
    const [notice, setNotice] = createSignal("");
    const notifications = createNotifications();
    const [saves, setSaves] = createSignal<
        Partial<Record<SaveKey, { status: SaveStatusValue; valid: boolean; retry: () => void }>>
    >({});
    const saving = () => Object.values(saves()).some((save) => save.status === "pending");
    const failed = () => {
        const keys: SaveKey[] = [
            "photos",
            "emojis",
            "photoSettings",
            "emojiSettings",
            "appearanceSettings",
            "appearancePresets",
        ];
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
                            busy={!!operation()}
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
                        {(id) => {
                            // Keep this account's stable store during disposal flushes,
                            // rather than reading the newly active account's settings.
                            const accountState = untrack(data);
                            return (
                                <AccountWorkspace
                                    api={accountApi(id)}
                                    notify={notifications.push}
                                    state={accountState}
                                    now={now()}
                                    busy={!!operation()}
                                    reordering={operation() === "reorder"}
                                    perform={perform}
                                    refresh={refresh}
                                    reportSave={reportSave}
                                />
                            );
                        }}
                    </Show>
                )}
            </Show>
        </main>
    );
}
