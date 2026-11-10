import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { AppearancePanel } from "./Appearance";
import { reconcilePhotoOrder, type State } from "./api";
import { Login, type AccountActions } from "./Accounts";
import { createAutosave } from "./autosave";
import { EmojiPicker } from "./EmojiPicker";
import { Photos } from "./Photos";
import { Rotation, RotationProgress } from "./Rotation";
import { trackAutosave, type ReportSave } from "./save-status";
import { t } from "./i18n";
import {
    Button,
    Tabs,
    TabsContent,
    TabsIndicator,
    TabsList,
    TabsTrigger,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "./components/ui";

type Notify = (message: string, action?: () => void) => void;

export function AccountWorkspace(
    props: AccountActions & {
        notify: Notify;
        state: State;
        now: number;
        reordering: boolean;
        refresh: () => Promise<void>;
        reportSave: ReportSave;
    },
) {
    const [selectedTab, setTab] = createSignal<"photos" | "emojis" | "appearance">("photos");
    const photoStatuses = createMemo(() =>
        props.state.photos.some((photo) => !!photo.emoji_status),
    );
    const photoAppearances = createMemo(() =>
        props.state.photos.some(
            (photo) => photo.appearance.profile !== null || photo.appearance.name !== null,
        ),
    );
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
    // oxlint-disable-next-line solid/reactivity -- trackAutosave invokes this callback from its effect and cleanup.
    trackAutosave(photoOrder, (status, valid, retry) =>
        props.reportSave("photos", status, valid, retry),
    );
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
    // oxlint-disable-next-line solid/reactivity -- trackAutosave invokes this callback from its effect and cleanup.
    trackAutosave(emojis, (status, valid, retry) =>
        props.reportSave("emojis", status, valid, retry),
    );
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
                onChange={(value) =>
                    setTab(
                        value === "appearance"
                            ? "appearance"
                            : value === "emojis"
                              ? "emojis"
                              : "photos",
                    )
                }
            >
                <TabsList aria-label={t("rotationSettings")}>
                    <TabsTrigger value="photos" aria-controls="photos-panel">
                        {t("profilePhotos")}
                        <RotationProgress
                            settings={props.state.settings}
                            applied={props.state.applied_settings}
                            next={props.state.next_rotation_at}
                            now={props.now}
                            label="nextPhoto"
                        />
                    </TabsTrigger>
                    <PremiumRotationTab value="emojis" premium={premium()}>
                        {t("emojiStatus")}
                        <RotationProgress
                            settings={props.state.emoji_settings}
                            applied={props.state.applied_emoji_settings}
                            next={props.state.next_emoji_rotation_at}
                            now={props.now}
                            label="nextEmoji"
                        />
                    </PremiumRotationTab>
                    <PremiumRotationTab value="appearance" premium={premium()}>
                        {t("appearance")}
                        <RotationProgress
                            settings={props.state.appearance_settings}
                            applied={props.state.applied_appearance_settings}
                            next={props.state.next_appearance_rotation_at}
                            now={props.now}
                            label="nextAppearance"
                        />
                    </PremiumRotationTab>
                    <TabsIndicator />
                </TabsList>
                <div class="relative">
                    <TabsContent
                        value="appearance"
                        id="appearance-panel"
                        forceMount
                        inert={tab() !== "appearance"}
                        aria-hidden={tab() !== "appearance" ? "true" : undefined}
                        class={tab() === "appearance" ? "relative" : "hidden"}
                    >
                        <PhotoRotationConflict
                            conflict={photoAppearances()}
                            message={t("photoAppearanceConflict")}
                            clearLabel={t("clearAllPhotoAppearances")}
                            busy={props.busy}
                            clear={() => {
                                const ids = props.state.photos
                                    .filter(
                                        (photo) =>
                                            photo.appearance.profile !== null ||
                                            photo.appearance.name !== null,
                                    )
                                    .map((photo) => photo.id);
                                const api = props.api;
                                void props.perform(() => api.clearPhotoAppearances(ids));
                            }}
                        >
                            <AppearancePanel
                                api={props.api}
                                state={props.state}
                                premium={premium()}
                                busy={props.busy}
                                refresh={props.refresh}
                                reportSave={(status, retry) =>
                                    props.reportSave("appearancePresets", status, true, retry)
                                }
                            >
                                {(dirty) => (
                                    <Rotation
                                        api={props.api}
                                        target="appearance"
                                        actionBlocked={dirty()}
                                        settings={props.state.appearance_settings}
                                        count={props.state.appearance_presets.length}
                                        busy={props.busy || !premium() || photoAppearances()}
                                        locked={props.busy || !premium() || photoAppearances()}
                                        perform={props.perform}
                                        refresh={props.refresh}
                                        applied={props.state.applied_appearance_settings}
                                        reportSave={props.reportSave}
                                    />
                                )}
                            </AppearancePanel>
                        </PhotoRotationConflict>
                    </TabsContent>
                    <TabsContent
                        value="photos"
                        id="photos-panel"
                        forceMount
                        inert={tab() !== "photos"}
                        aria-hidden={tab() !== "photos" ? "true" : undefined}
                        class={[
                            "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-out",
                            tab() === "photos"
                                ? "relative opacity-100 translate-none"
                                : "pointer-events-none invisible absolute inset-x-0 top-0 opacity-0 -translate-y-2",
                        ]}
                    >
                        <Photos
                            profile={props.state.profile}
                            premium={premium()}
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
                                ? "relative opacity-100 translate-none"
                                : "pointer-events-none invisible absolute inset-x-0 top-0 opacity-0 translate-y-2",
                        ]}
                    >
                        <PhotoRotationConflict
                            conflict={photoStatuses()}
                            message={t("photoEmojiConflict")}
                            clearLabel={t("clearAllPhotoStatuses")}
                            busy={props.busy}
                            clear={() => {
                                const ids = props.state.photos
                                    .filter((photo) => photo.emoji_status)
                                    .map((photo) => photo.id);
                                const api = props.api;
                                void props.perform(() => api.clearPhotoEmojis(ids));
                            }}
                        >
                            <EmojiPicker
                                active={tab() === "emojis"}
                                api={props.api}
                                notify={props.notify}
                                selected={props.state.selected_emoji_ids}
                                selectedEmojis={props.state.selected_emojis}
                                premium={premium()}
                                busy={props.busy || photoStatuses()}
                                autosave={emojis}
                            />
                            <Show when={premium()}>
                                <Rotation
                                    api={props.api}
                                    target="emoji"
                                    settings={props.state.emoji_settings}
                                    count={
                                        (emojis.draft() ?? props.state.selected_emoji_ids).length
                                    }
                                    busy={(props.busy && !props.reordering) || photoStatuses()}
                                    locked={props.busy || photoStatuses()}
                                    perform={props.perform}
                                    refresh={props.refresh}
                                    applied={props.state.applied_emoji_settings}
                                    beforeAction={emojis.flush}
                                    reportSave={props.reportSave}
                                />
                            </Show>
                        </PhotoRotationConflict>
                    </TabsContent>
                </div>
            </Tabs>
        </Show>
    );
}

function PremiumRotationTab(props: {
    value: "emojis" | "appearance";
    premium: boolean;
    children: JSX.Element;
}) {
    return (
        <Tooltip>
            <TooltipTrigger
                as="span"
                class="inline-flex flex-1"
                tabindex={props.premium ? undefined : 0}
            >
                <TabsTrigger
                    value={props.value}
                    aria-controls={`${props.value}-panel`}
                    disabled={!props.premium}
                >
                    {props.children}
                </TabsTrigger>
            </TooltipTrigger>
            <Show when={!props.premium}>
                <TooltipContent>{t("premiumRequired")}</TooltipContent>
            </Show>
        </Tooltip>
    );
}

function PhotoRotationConflict(props: {
    conflict: boolean;
    message: string;
    clearLabel: string;
    busy: boolean;
    clear: () => void;
    children: JSX.Element;
}) {
    return (
        <>
            <Show when={props.conflict}>
                <div class="mt-4 space-y-3">
                    <p class="text-sm text-muted-foreground" role="status">
                        {props.message}
                    </p>
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={props.busy}
                        onClick={props.clear}
                    >
                        {props.clearLabel}
                    </Button>
                </div>
            </Show>
            <fieldset
                disabled={props.conflict}
                class="m-0 min-w-0 border-0 p-0 disabled:opacity-60"
            >
                {props.children}
            </fieldset>
        </>
    );
}
