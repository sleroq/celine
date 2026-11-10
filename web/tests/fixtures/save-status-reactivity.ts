import assert from "node:assert/strict";
import { createRoot, createSignal, flush } from "solid-js";
import { trackAutosave, type SaveStatusValue } from "../../src/save-status";

createRoot((dispose) => {
    const [status, setStatus] = createSignal<SaveStatusValue>("idle");
    const [valid, setValid] = createSignal(true);
    const reports: { status: SaveStatusValue; valid: boolean; retry: () => void }[] = [];
    let retries = 0;
    // oxlint-disable-next-line solid/reactivity -- trackAutosave tracks valid in its effect; this fixture verifies that subscription.
    trackAutosave(
        {
            status,
            async retry() {
                retries++;
                throw new Error("Still unavailable");
            },
        },
        (status, valid, retry) => reports.push({ status, valid, retry }),
        valid,
    );
    flush();
    assert.equal(reports.at(-1)?.status, "idle");
    assert.equal(reports.at(-1)?.valid, true);

    setStatus("error");
    setValid(false);
    flush();
    assert.equal(reports.at(-1)?.status, "error");
    assert.equal(reports.at(-1)?.valid, false);

    setValid(true);
    flush();
    assert.equal(reports.at(-1)?.valid, true);
    reports.at(-1)!.retry();
    assert.equal(retries, 1);

    setStatus("pending");
    flush();
    assert.equal(reports.at(-1)?.status, "pending");
    dispose();
    assert.equal(reports.at(-1)?.status, "idle");
    assert.equal(reports.at(-1)?.valid, true);
    reports.at(-1)!.retry();
    assert.equal(retries, 1);
    const disposedReports = reports.length;
    setStatus("saved");
    flush();
    assert.equal(reports.length, disposedReports);
});
