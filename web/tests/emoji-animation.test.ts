import { afterEach, beforeEach, expect, test } from "bun:test";
import type { TLottieConfig, TLottieEventName, TLottieListener } from "tlottie";
import { createEmojiAnimationRegistry } from "../src/emoji-animation";

class Container {
    children: Canvas[] = [];
    append(canvas: Canvas) {
        canvas.remove();
        canvas.removed = false;
        canvas.parent = this;
        this.children.push(canvas);
    }
}
class Canvas {
    style = { cssText: "" };
    width = 0;
    height = 0;
    removed = false;
    transferred = false;
    parent: Container | undefined;
    draws: Canvas[] = [];
    setAttribute() {}
    remove() {
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = undefined;
        this.removed = true;
    }
    replaceWith(canvas: Canvas) {
        const parent = this.parent!;
        this.remove();
        parent.append(canvas);
    }
    getContext() {
        if (this.transferred) throw new Error("transferred canvas");
        return { clearRect() {}, drawImage: (source: Canvas) => this.draws.push(source) };
    }
}
class Player {
    listeners = new Map<TLottieEventName, TLottieListener>();
    destroyed = 0;
    readonly config: TLottieConfig;
    constructor(config: TLottieConfig) {
        this.config = config;
    }
    on(event: TLottieEventName, callback: TLottieListener) {
        this.listeners.set(event, callback);
    }
    destroy() {
        this.destroyed++;
    }
    emit(event: TLottieEventName) {
        this.listeners.get(event)?.({});
    }
}
const originals = new Map<string, PropertyDescriptor | undefined>();
let frames: Map<number, FrameRequestCallback>;
let body: Container;
let canvases: Canvas[];
let players: Player[];
let idle: number;
let registry: ReturnType<typeof createEmojiAnimationRegistry>;
type BrowserStub =
    | { createElement: (tag: string) => Canvas | Container; body: Container }
    | ((callback: FrameRequestCallback) => number)
    | ((id: number) => boolean);
function stub(name: string, value: BrowserStub) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
beforeEach(() => {
    frames = new Map();
    body = new Container();
    canvases = [];
    players = [];
    idle = 0;
    let id = 0;
    stub("document", {
        createElement: (tag: string) => {
            if (tag === "span") return new Container();
            const canvas = new Canvas();
            canvases.push(canvas);
            return canvas;
        },
        body,
    });
    stub("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++id, callback);
        return id;
    });
    stub("cancelAnimationFrame", (id: number) => frames.delete(id));
    registry = createEmojiAnimationRegistry(
        (config) => {
            if (!(config.canvas instanceof Canvas)) throw new Error("Expected stub canvas");
            config.canvas.transferred = true;
            const player = new Player(config);
            players.push(player);
            return player;
        },
        () => idle++,
    );
});
afterEach(() => {
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
    originals.clear();
});
function subscribe(error = () => {}) {
    const container = document.createElement("span");
    let ready = 0;
    const unsubscribe = registry.subscribe({
        url: "/api/accounts/1/media/a",
        width: 20,
        height: 24,
        dpr: 2,
        data: {},
        container,
        ready: () => ready++,
        error,
    });
    return { canvas: canvases[canvases.length - 1]!, container, unsubscribe, ready: () => ready };
}
function tick() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
}

test("same asset directly renders primary, copies secondary, and promotes without a new player", () => {
    const a = subscribe();
    const b = subscribe();
    expect(players).toHaveLength(1);
    expect(players[0]!.config).toMatchObject({ loop: true, autoplay: true, forceRender: true });
    expect(a.canvas.width).toBe(40);
    players[0]!.emit("load");
    tick();
    expect(a.canvas.draws).toEqual([]);
    expect(b.canvas.draws).toEqual([a.canvas]);
    expect(a.ready()).toBe(1);
    expect(b.ready()).toBe(1);
    tick();
    expect(a.ready()).toBe(1);
    a.unsubscribe();
    expect(players[0]!.destroyed).toBe(0);
    expect(Object.is(b.container.children[0], a.canvas)).toBe(true);
    expect(b.canvas.removed).toBe(true);
    expect(players).toHaveLength(1);
    expect(frames.size).toBe(0);
    b.unsubscribe();
    b.unsubscribe();
    expect(players[0]!.destroyed).toBe(1);
    expect(a.canvas.removed).toBe(true);
    expect(frames.size).toBe(0);
    expect(idle).toBe(1);
});
test("pending unsubscribe defers destroy until load", () => {
    const a = subscribe();
    a.unsubscribe();
    expect(players[0]!.destroyed).toBe(0);
    expect(idle).toBe(0);
    players[0]!.emit("load");
    players[0]!.emit("load");
    expect(players[0]!.destroyed).toBe(1);
    expect(frames.size).toBe(0);
    expect(idle).toBe(1);
});
test("rejoining a pending entry reuses its initialization", () => {
    const a = subscribe();
    a.unsubscribe();
    expect(body.children).toEqual([a.canvas]);
    const b = subscribe();
    expect(b.canvas).toBe(a.canvas);
    expect(body.children).toHaveLength(0);
    expect(players).toHaveLength(1);
    players[0]!.emit("load");
    tick();
    expect(b.ready()).toBe(1);
    b.unsubscribe();
    expect(players[0]!.destroyed).toBe(1);
});
test("worker errors notify all subscribers once and dispose", () => {
    let errors = 0;
    const a = subscribe(() => {
        errors++;
        a.unsubscribe();
        b.unsubscribe();
    });
    const b = subscribe(() => errors++);
    players[0]!.emit("error");
    players[0]!.emit("error");
    expect(errors).toBe(2);
    expect(players[0]!.destroyed).toBe(1);
    a.unsubscribe();
    b.unsubscribe();
    expect(players[0]!.destroyed).toBe(1);
    subscribe();
    expect(players).toHaveLength(2);
});

test("a loaded primary reports ready on one frame without an ongoing loop", () => {
    const a = subscribe();
    players[0]!.emit("load");
    expect(a.ready()).toBe(0);
    tick();
    expect(a.ready()).toBe(1);
    expect(frames.size).toBe(0);
    expect(canvases).toHaveLength(1);
    a.unsubscribe();
});
test("keeps the worker while another animation is active", () => {
    const a = subscribe();
    const container = document.createElement("span");
    const detach = registry.subscribe({
        url: "/api/accounts/1/media/b",
        width: 20,
        height: 24,
        dpr: 2,
        data: {},
        container,
        ready() {},
        error() {},
    });
    players[0]!.emit("load");
    players[1]!.emit("load");
    a.unsubscribe();
    expect(idle).toBe(0);
    detach();
    expect(idle).toBe(1);
});

test("resize lifecycle creates a new source while pending old size settles", () => {
    const a = subscribe();
    a.unsubscribe();
    const container = document.createElement("span");
    const detach = registry.subscribe({
        url: "/api/accounts/1/media/a",
        width: 30,
        height: 30,
        dpr: 2,
        data: {},
        container,
        ready() {},
        error() {},
    });
    expect(players).toHaveLength(2);
    expect(canvases[canvases.length - 1]!.width).toBe(60);
    players[0]!.emit("load");
    expect(players[0]!.destroyed).toBe(1);
    players[1]!.emit("load");
    detach();
    expect(container.children).toHaveLength(0);
});
