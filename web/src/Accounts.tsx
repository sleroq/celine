import { createEffect, createSignal, For, Show } from "solid-js";
import { accountApi, request, timeRemaining } from "./api";
import type { AccountApi, AccountSummary, State } from "./api";
import { ProfileHeader } from "./ProfileHeader";
import { serverMessage, t } from "./i18n";
import { Button, Input, Label } from "./components/ui";

export type Actions = {
    busy: boolean;
    perform: (work: () => Promise<void>, message?: string, activity?: "reorder") => Promise<void>;
};

export function AccountMenu(
    props: Actions & {
        accounts: AccountSummary[];
        activeId: string;
        now: number;
        unsaved: boolean;
    },
) {
    const [open, setOpen] = createSignal(false);
    let container!: HTMLDivElement;
    let trigger!: HTMLButtonElement;
    const active = () => props.accounts.find((account) => account.id === props.activeId);
    const pending = () => props.accounts.some((account) => account.pending);
    const name = (account?: AccountSummary) =>
        account?.profile?.name ?? account?.auth.name ?? t("accountsNew");

    createEffect(open, (visible) => {
        if (!visible) return;
        const outside = (event: PointerEvent) => {
            if (!event.composedPath().includes(container)) setOpen(false);
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
                trigger.focus();
            }
        };
        document.addEventListener("pointerdown", outside);
        document.addEventListener("keydown", escape);
        return () => {
            document.removeEventListener("pointerdown", outside);
            document.removeEventListener("keydown", escape);
        };
    });

    function choose(work: () => Promise<void>) {
        setOpen(false);
        trigger.focus();
        void props.perform(work);
    }

    return (
        <div
            class={["account-menu", { "account-menu-open": open() }]}
            ref={(element) => {
                container = element;
            }}
        >
            <div class="account-current">
                <button
                    type="button"
                    class="account-trigger"
                    ref={(element) => {
                        trigger = element;
                    }}
                    aria-label={t("accountsManage", { name: name(active()) })}
                    aria-expanded={open() ? "true" : "false"}
                    aria-current={open() ? "true" : undefined}
                    aria-controls="account-picker"
                    onClick={() => setOpen(!open())}
                >
                    <ProfileHeader
                        profile={active()?.profile}
                        name={name(active())}
                        now={props.now}
                    />
                </button>
                <Show when={open()}>
                    <LogoutButton
                        name={name(active())}
                        busy={props.busy}
                        logout={() => choose(accountApi(props.activeId).logout)}
                    />
                </Show>
            </div>
            <Show when={open()}>
                <div
                    id="account-picker"
                    class="account-picker"
                    role="group"
                    aria-label={t("accountsTelegram")}
                >
                    <Show when={props.unsaved}>
                        <p role="status">{t("finishSavingBeforeSwitch")}</p>
                    </Show>
                    <ul class="account-list">
                        <For
                            each={props.accounts
                                .filter((account) => account.id !== props.activeId)
                                .map((account) => account.id)}
                        >
                            {(id) => {
                                const account = () => props.accounts.find((item) => item.id === id);
                                return (
                                    <li>
                                        <button
                                            type="button"
                                            class="account-switch"
                                            disabled={props.busy}
                                            aria-label={t("accountsSwitch", {
                                                name: name(account()),
                                            })}
                                            onClick={() => choose(() => accountApi(id).activate())}
                                        >
                                            <ProfileHeader
                                                profile={account()?.profile}
                                                name={name(account())}
                                                now={props.now}
                                            />
                                        </button>
                                        <LogoutButton
                                            name={name(account())}
                                            busy={props.busy}
                                            logout={() => {
                                                void props.perform(accountApi(id).logout);
                                            }}
                                        />
                                    </li>
                                );
                            }}
                        </For>
                    </ul>
                    <Show when={!pending()}>
                        <button
                            type="button"
                            class="account-add"
                            disabled={props.busy}
                            onClick={() => choose(() => request("accounts", "POST"))}
                        >
                            <span aria-hidden="true">＋</span> {t("accountsAdd")}
                        </button>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

function LogoutButton(props: { name: string; busy: boolean; logout: () => void }) {
    return (
        <button
            type="button"
            class="account-logout"
            disabled={props.busy}
            aria-label={t("accountsLogout", { name: props.name })}
            title={t("accountsLogout", { name: props.name })}
            onClick={() => props.logout()}
        >
            <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M10 5H5v14h5M14 8l4 4-4 4M9 12h10" />
            </svg>
        </button>
    );
}

export function Login(props: Actions & { api: AccountApi; auth: State["auth"]; now: number }) {
    const [password, setPassword] = createSignal("");
    const [loading, setLoading] = createSignal(true);
    const expired = () => props.auth.expires_at != null && props.auth.expires_at <= props.now;
    let started = false;

    createEffect(
        () => [props.auth.status, props.auth.message_info?.code, props.busy] as const,
        ([status, message, busy]) => {
            if (status === "qr" || status === "password") {
                started = true;
                setLoading(false);
            }
            if (
                !started &&
                !busy &&
                (status === "qr_expired" ||
                    (status === "disconnected" &&
                        message !== "auth.connecting" &&
                        message !== "auth.verifying"))
            ) {
                started = true;
                void props
                    /* oxlint-disable solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation. */
                    .perform(() => props.api.request("auth/qr", "POST"))
                    .finally(() => setLoading(false));
                /* oxlint-enable solid/reactivity */
            }
        },
    );

    return (
        <section
            aria-labelledby="login-title"
            class="mx-auto my-8! w-full max-w-md rounded-xl bg-surface p-5 text-foreground sm:p-6"
        >
            <h2 id="login-title" class="m-0 text-xl! font-semibold tracking-tight text-balance">
                {t("loginTitle")}
            </h2>
            <Show when={props.auth.message}>
                {(message) => (
                    <p class="mt-3 mb-0 text-sm text-muted-foreground text-pretty">
                        {serverMessage(props.auth.message_info, message())}
                    </p>
                )}
            </Show>
            <Show
                when={
                    (((props.auth.status === "disconnected" &&
                        props.auth.message_info?.code !== "auth.verifying") ||
                        props.auth.status === "qr_expired") &&
                        loading()) ||
                    (props.auth.status === "qr" && (!props.auth.qr_svg || expired()))
                }
            >
                <div class="mt-6 flex flex-col items-center gap-3">
                    <span
                        class="block aspect-square w-64 max-w-full rounded-lg bg-muted motion-safe:animate-pulse"
                        aria-hidden="true"
                    />
                    <p role="status" class="m-0 text-center text-sm text-muted-foreground">
                        {t("loginQrRefreshing")}
                    </p>
                </div>
            </Show>
            <Show when={props.auth.status === "qr_expired" && !loading()}>
                <p role="status" class="mt-4 mb-0 rounded-lg bg-muted p-3 text-sm text-pretty">
                    {t("loginQrStopped")}
                </p>
            </Show>
            <Show when={props.auth.status === "qr"}>
                <p class="mt-3 mb-0 text-sm leading-relaxed text-muted-foreground text-pretty">
                    {t("loginQrInstructions")}
                </p>
                <Show when={props.auth.qr_svg && !expired()}>
                    <div class="mt-6 flex flex-col items-center gap-3">
                        <div class="max-w-full rounded-lg bg-white p-3">
                            <img
                                class="block w-64 max-w-full"
                                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.auth.qr_svg!)}`}
                                alt={t("loginQrAlt")}
                            />
                        </div>
                        <p
                            role="status"
                            class="m-0 text-center text-sm text-muted-foreground tabular-nums"
                        >
                            {props.auth.expires_at
                                ? t("loginQrExpires", {
                                      time: timeRemaining(props.auth.expires_at, props.now),
                                  })
                                : t("loginWaiting")}
                        </p>
                    </div>
                </Show>
            </Show>
            <Show when={props.auth.status === "password"}>
                <form
                    class="mt-6! mb-0! grid gap-4!"
                    onSubmit={(event) => {
                        event.preventDefault();
                        // oxlint-disable-next-line solid/reactivity -- perform invokes this callback when the action runs; it is not a reactive computation.
                        void props.perform(async () => {
                            await props.api.request("auth/password", "POST", {
                                password: password(),
                            });
                            setPassword("");
                        });
                    }}
                >
                    <div class="grid gap-2">
                        <Label for="password">{t("loginPassword")}</Label>
                        <Input
                            id="password"
                            type="password"
                            autocomplete="current-password"
                            required
                            disabled={props.busy}
                            value={password()}
                            onInput={(event) => setPassword(event.currentTarget.value)}
                        />
                    </div>
                    <Button disabled={props.busy} type="submit">
                        {t("loginContinue")}
                    </Button>
                </form>
            </Show>
        </section>
    );
}
