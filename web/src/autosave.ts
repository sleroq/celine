import { createSignal } from "solid-js";

// Keep the latest edit visible while writes are serialized, including after a failure.
export function createAutosave<T>(
    write: (value: T) => Promise<void>,
    refresh: () => Promise<void>,
    delay = 400,
) {
    const [draft, setDraft] = createSignal<T>();
    const [status, setStatus] = createSignal<"idle" | "pending" | "saved" | "error">("idle");
    let valid = true;
    let version = 0;
    let savedVersion = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | undefined;

    function edit(value: T, isValid = true) {
        valid = isValid;
        setDraft(() => value);
        version++;
        clearTimeout(timer);
        setStatus(valid ? "pending" : "error");
        if (valid)
            timer = setTimeout(() => {
                void flush().catch(() => {});
            }, delay);
    }

    function flush(): Promise<void> {
        clearTimeout(timer);
        if (running) return running;
        if (savedVersion === version && draft() === undefined) return Promise.resolve();
        running = (async () => {
            try {
                while (savedVersion !== version) {
                    if (!valid) throw new Error("Invalid settings");
                    const current = version;
                    const value = draft()!;
                    await write(value);
                    savedVersion = current;
                }
                await refresh();
                if (savedVersion === version) setStatus("saved");
            } catch (error) {
                setStatus("error");
                throw error;
            } finally {
                running = undefined;
            }
            if (savedVersion !== version) await flush();
        })();
        return running;
    }

    function retry() {
        setStatus("pending");
        return flush();
    }

    function acknowledge() {
        setDraft(() => undefined);
    }
    function dispose() {
        clearTimeout(timer);
        if (valid && savedVersion !== version) void flush().catch(() => {});
    }
    return { draft, status, edit, flush, retry, acknowledge, dispose };
}
