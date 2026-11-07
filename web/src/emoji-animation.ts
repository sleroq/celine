import type { TLottie, TLottieConfig } from "tlottie";

type Player = Pick<TLottie, "on" | "destroy">;
type View = {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D | null;
    ready: () => void;
    error: () => void;
    painted: boolean;
};
type Entry = {
    source: HTMLCanvasElement;
    player: Player;
    views: Set<View>;
    loaded: boolean;
    failed: boolean;
};

// The constructor is supplied lazily, keeping the worker/WASM out of non-TGS paths.
export function createEmojiAnimationRegistry(
    createPlayer: (config: TLottieConfig) => Player,
    onIdle: () => void = () => {},
) {
    const entries = new Map<string, Entry>();
    let frame: number | undefined;

    function dispose(key: string, entry: Entry) {
        if (entries.get(key) !== entry) return;
        entries.delete(key);
        entry.player.destroy();
        entry.source.remove();
        if (!entries.size) onIdle();
    }

    function schedule() {
        if (frame !== undefined) return;
        for (const entry of entries.values()) {
            if (!entry.loaded || entry.failed) continue;
            for (const view of entry.views) {
                if (view.context || !view.painted) {
                    frame = requestAnimationFrame(paint);
                    return;
                }
            }
        }
    }

    function paint() {
        frame = undefined;
        for (const entry of entries.values()) {
            if (!entry.loaded || entry.failed) continue;
            for (const view of entry.views) {
                try {
                    if (view.context) {
                        view.context.clearRect(0, 0, view.canvas.width, view.canvas.height);
                        view.context.drawImage(
                            entry.source,
                            0,
                            0,
                            view.canvas.width,
                            view.canvas.height,
                        );
                    }
                    if (!view.painted) {
                        view.painted = true;
                        view.ready();
                    }
                } catch {
                    view.error();
                }
            }
        }
        schedule();
    }

    return {
        subscribe(options: {
            url: string;
            width: number;
            height: number;
            dpr: number;
            data: unknown;
            container: HTMLElement;
            ready: () => void;
            error: () => void;
        }) {
            const { url, width, height, dpr, container, ready, error } = options;
            const key = JSON.stringify([url, width, height, dpr]);

            let entry = entries.get(key);
            if (!entry) {
                const source = document.createElement("canvas");
                source.setAttribute("aria-hidden", "true");
                source.style.cssText = "width:100%;height:100%";
                source.width = Math.round(width * dpr);
                source.height = Math.round(height * dpr);
                container.append(source);
                let player: Player;
                try {
                    player = createPlayer({
                        canvas: source,
                        data: JSON.stringify(options.data),
                        loop: true,
                        autoplay: true,
                        forceRender: true,
                    });
                } catch (error) {
                    source.remove();
                    throw error;
                }
                entry = { source, player, views: new Set(), loaded: false, failed: false };
                entries.set(key, entry);
                const owned = entry;
                player.on("load", () => {
                    if (owned.loaded || owned.failed) return;
                    owned.loaded = true;
                    if (!owned.views.size) dispose(key, owned);
                    else schedule();
                });
                player.on("error", () => {
                    if (owned.failed) return;
                    owned.failed = true;
                    // Do not destroy pending players before load/error: tlottie 0.3.0
                    // ignores worker destroy messages during async WASM initialization.
                    const views = [...owned.views];
                    owned.views.clear();
                    for (const view of views) view.canvas.remove();
                    dispose(key, owned);
                    schedule();
                    for (const view of views) view.error();
                });
            }
            const primary = !entry.views.size;
            const canvas = primary ? entry.source : document.createElement("canvas");
            let context: CanvasRenderingContext2D | null = null;
            if (!primary) {
                canvas.width = Math.round(width * dpr);
                canvas.height = Math.round(height * dpr);
                context = canvas.getContext("2d");
                if (!context) throw new Error("Canvas context unavailable");
            }
            canvas.style.cssText = "width:100%;height:100%";
            container.append(canvas);
            const view = { canvas, context, ready, error, painted: false };
            entry.views.add(view);
            schedule();
            const owned = entry;
            return () => {
                if (!owned.views.delete(view)) return;
                if (view.canvas === owned.source && owned.views.size) {
                    const successor = owned.views.values().next().value!;
                    successor.canvas.replaceWith(owned.source);
                    successor.canvas = owned.source;
                    successor.context = null;
                } else if (!owned.views.size && !owned.loaded && !owned.failed) {
                    // tlottie 0.3.0 ignores destroy during async WASM initialization.
                    // Keep its transferred canvas measurable until load/error settles.
                    owned.source.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none`;
                    document.body.append(owned.source);
                } else {
                    view.canvas.remove();
                }
                if (!owned.views.size && (owned.loaded || owned.failed)) dispose(key, owned);
                if (
                    frame !== undefined &&
                    ![...entries.values()].some(
                        (value) =>
                            value.loaded &&
                            [...value.views].some((view) => view.context || !view.painted),
                    )
                ) {
                    cancelAnimationFrame(frame);
                    frame = undefined;
                }
            };
        },
    };
}

let shared: ReturnType<typeof createEmojiAnimationRegistry> | undefined;
export async function emojiAnimations() {
    const { TLottie, TLottieWorkerPool } = await import("tlottie");
    if (!shared) {
        const pool = new TLottieWorkerPool(1);
        shared = createEmojiAnimationRegistry(
            (config) => new TLottie({ ...config, pool }),
            () => pool.terminateAll(),
        );
    }
    return shared;
}
