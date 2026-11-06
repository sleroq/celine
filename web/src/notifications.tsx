import { For, Show } from "solid-js";
import { t } from "./i18n";
import type { createNotifications } from "./notification-center";
import { Button } from "./components/ui";

export function Notifications(props: { center: ReturnType<typeof createNotifications> }) {
    return (
        <div
            class="pointer-events-none fixed inset-e-4 bottom-4 z-10 grid max-h-[calc(100dvh-2rem)] w-[min(24rem,calc(100vw-2rem))] gap-2 overflow-y-auto"
            aria-live="polite"
            aria-relevant="additions"
        >
            <For each={props.center.items()}>
                {(item) => (
                    <div
                        class="pointer-events-auto flex items-center gap-2 rounded-xl bg-surface p-3 text-foreground shadow-lg"
                        role="status"
                    >
                        <span class="min-w-0 flex-1 wrap-anywhere">{item.message}</span>
                        <Show when={item.action}>
                            {(action) => (
                                <Button
                                    variant="secondary"
                                    class="shrink-0"
                                    size="sm"
                                    onClick={() => {
                                        props.center.dismiss(item.id);

                                        action()();
                                    }}
                                >
                                    {t("retry")}
                                </Button>
                            )}
                        </Show>
                        <Button
                            variant="ghost"
                            size="icon"
                            class="shrink-0 text-xl"
                            aria-label={t("dismissNotification")}
                            onClick={() => props.center.dismiss(item.id)}
                        >
                            ×
                        </Button>
                    </div>
                )}
            </For>
        </div>
    );
}
