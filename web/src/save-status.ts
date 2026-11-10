import { createEffect, onCleanup, type Accessor } from "solid-js";

export type SaveStatusValue = "idle" | "pending" | "saved" | "error";
export type SaveKey =
    | "photos"
    | "emojis"
    | "photoSettings"
    | "emojiSettings"
    | "appearanceSettings"
    | "appearancePresets";
export type ReportSave = (
    key: SaveKey,
    status: SaveStatusValue,
    valid: boolean,
    retry: () => void,
) => void;

type SaveSource = {
    status: Accessor<SaveStatusValue>;
    retry: () => Promise<void>;
};

export function trackAutosave(
    source: SaveSource,
    report: (status: SaveStatusValue, valid: boolean, retry: () => void) => void,
    valid: Accessor<boolean> = () => true,
) {
    function retry() {
        void source.retry().catch(() => {});
    }
    createEffect(
        () => [source.status(), valid()] as const,
        ([status, isValid]) => {
            report(status, isValid, retry);
        },
    );
    onCleanup(() => {
        report("idle", true, () => {});
    });
}
