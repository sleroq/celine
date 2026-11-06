import { createSignal, onCleanup } from "solid-js";

type Notification = { id: number; message: string; action?: () => void };

export function createNotifications(lifetime = 6000) {
    const [items, setItems] = createSignal<Notification[]>([]);
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextId = 0;
    function dismiss(id: number) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        setItems((current) => current.filter((item) => item.id !== id));
    }
    function push(message: string, action?: () => void) {
        const id = ++nextId;
        setItems((current) => [...current, { id, message, action }]);
        timers.set(
            id,
            setTimeout(() => dismiss(id), lifetime),
        );
        return id;
    }
    onCleanup(() => {
        for (const timer of timers.values()) clearTimeout(timer);
    });
    return { items, push, dismiss };
}
