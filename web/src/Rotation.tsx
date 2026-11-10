import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { timeRemaining, type Settings } from "./api";
import type { AccountActions } from "./Accounts";
import { createAutosave } from "./autosave";
import { Duration } from "./duration";
import { trackAutosave, type ReportSave } from "./save-status";
import { t } from "./i18n";
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
    SelectTrigger,
    SelectValue,
    TextField,
    TextFieldInput,
    TextFieldLabel,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "./components/ui";

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
                    <SelectContent />
                </Select>
            </div>
        </TextField>
    );
}

export function RotationProgress(props: {
    settings: Settings;
    applied: Settings | null;
    next: number | null;
    now: number;
    label: "nextPhoto" | "nextEmoji" | "nextAppearance";
}) {
    const status = () =>
        !props.settings.enabled
            ? t("stopped")
            : props.next != null
              ? t(props.label, { time: timeRemaining(props.next, props.now) })
              : t("running");
    const progress = () =>
        props.next == null || !props.applied
            ? 0
            : Math.max(0, Math.min(1, 1 - (props.next - props.now) / props.applied.interval_secs));

    return (
        <Tooltip>
            <TooltipTrigger as="span" class="inline-flex" aria-hidden="true">
                <svg viewBox="0 0 20 20" class="size-5" fill="none">
                    <circle
                        cx="10"
                        cy="10"
                        r="8"
                        stroke="currentColor"
                        stroke-opacity="0.25"
                        stroke-width="2"
                    />
                    <Show
                        when={props.settings.enabled}
                        fallback={
                            <path
                                d="M8 7v6M12 7v6"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                            />
                        }
                    >
                        <circle
                            cx="10"
                            cy="10"
                            r="8"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            pathLength="1"
                            stroke-dasharray={`${progress()} 1`}
                            transform="rotate(-90 10 10)"
                        />
                        <circle cx="10" cy="10" r="2" fill="currentColor" />
                    </Show>
                </svg>
            </TooltipTrigger>
            <TooltipContent>{status()}</TooltipContent>
            <span class="visually-hidden">{status()}</span>
        </Tooltip>
    );
}

export function Rotation(
    props: AccountActions & {
        target: "photo" | "emoji" | "appearance";
        actionBlocked?: boolean;
        settings: Settings;
        applied: Settings | null;
        count: number;
        locked: boolean;
        refresh: () => Promise<void>;
        beforeAction?: () => Promise<void>;
        reportSave: ReportSave;
    },
) {
    let jitterDetails!: HTMLDetailsElement;
    const endpoint = () =>
        props.target === "photo"
            ? "settings"
            : props.target === "appearance"
              ? "appearance/settings"
              : "emojis/settings";
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
    const saveKey = () =>
        props.target === "photo"
            ? "photoSettings"
            : props.target === "appearance"
              ? "appearanceSettings"
              : "emojiSettings";
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
    /* oxlint-disable solid/reactivity -- trackAutosave tracks valid and invokes the report from its effect and cleanup. */
    trackAutosave(
        autosave,
        (status, isValid, retry) => props.reportSave(saveKey(), status, isValid, retry),
        valid,
    );
    /* oxlint-enable solid/reactivity */
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
        if (name !== "stop" && props.actionBlocked) return;
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
        <section
            aria-label={
                props.target === "photo"
                    ? t("photoRotation")
                    : props.target === "appearance"
                      ? t("appearanceRotation")
                      : t("emojiRotation")
            }
        >
            <Card class="gap-0 rounded-2xl p-4 sm:p-5">
                <form
                    class="m-0! grid gap-4!"
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
                            class="cursor-pointer py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            aria-label={
                                settings().jitter_secs == null
                                    ? t("jitterAutomaticLabel")
                                    : t("jitterCustomLabel")
                            }
                            aria-describedby={fieldId("jitter-help")}
                        >
                            {t("jitter")}
                            <Tooltip>
                                <TooltipTrigger
                                    as="span"
                                    role="img"
                                    tabindex="0"
                                    aria-label={t("jitter")}
                                    aria-describedby={fieldId("jitter-help")}
                                    class="ms-1 inline-grid size-5 place-items-center rounded-full bg-surface text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                    onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            event.stopPropagation();
                                        }
                                    }}
                                >
                                    ?
                                </TooltipTrigger>
                                <TooltipContent>{t("jitterHelp")}</TooltipContent>
                            </Tooltip>
                            <span class="visually-hidden" id={fieldId("jitter-help")}>
                                {t("jitterHelp")}
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
                                <SelectContent />
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
                                    disabled={
                                        props.locked ||
                                        props.actionBlocked ||
                                        props.count === 0 ||
                                        !valid()
                                    }
                                    onClick={() => action("start")}
                                >
                                    {t("startRotation")}
                                </Button>
                            }
                        >
                            <Button
                                disabled={
                                    props.locked ||
                                    props.actionBlocked ||
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
            </Card>
        </section>
    );
}
