// Adapted from shadcn-solid (MIT): apps/docs/src/registry/ui/tabs.tsx.
import type { ComponentProps } from "@solidjs/web";
import { omit } from "solid-js";
import { Tabs as TabsPrimitive } from "@kobalte/core/tabs";

import { cx } from "../../lib/cva";

export type TabsProps = ComponentProps<typeof TabsPrimitive<"div">>;

export const Tabs = (props: TabsProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <TabsPrimitive
            data-slot="tabs"
            class={cx("flex flex-col gap-2", "data-[orientation=vertical]:flex-row", props.class)}
            {...rest}
        />
    );
};

export type TabsListProps = ComponentProps<typeof TabsPrimitive.List<"div">>;

export const TabsList = (props: TabsListProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <TabsPrimitive.List
            data-slot="tabs-list"
            class={cx(
                "bg-muted text-muted-foreground relative isolate flex min-h-11 w-fit items-stretch justify-center rounded-lg",
                "data-[orientation=vertical]:h-fit data-[orientation=vertical]:flex-col",
                props.class,
            )}
            {...rest}
        />
    );
};

export type TabsTriggerProps = ComponentProps<typeof TabsPrimitive.Trigger<"button">> & {
    value: string;
};

export const TabsTrigger = (props: TabsTriggerProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <TabsPrimitive.Trigger
            value={props.value}
            data-slot="tabs-trigger"
            class={cx(
                "text-foreground peer relative z-10 inline-flex min-h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border-0 bg-transparent px-3 py-2 font-[inherit] text-sm font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                props.class,
            )}
            {...rest}
        />
    );
};

export type TabsContentProps = ComponentProps<typeof TabsPrimitive.Content<"div">> & {
    value: string;
};

export const TabsContent = (props: TabsContentProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <TabsPrimitive.Content
            value={props.value}
            data-slot="tabs-content"
            class={cx(
                "min-w-0 flex-1 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                props.class,
            )}
            {...rest}
        />
    );
};

export type TabsIndicatorProps = ComponentProps<typeof TabsPrimitive.Indicator<"div">>;

export const TabsIndicator = (props: TabsIndicatorProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <TabsPrimitive.Indicator
            data-slot="tabs-indicator"
            class={cx(
                "bg-surface pointer-events-none absolute inset-0 rounded-lg motion-safe:transition-[transform,width,height] motion-safe:duration-200 motion-safe:ease-out",
                props.class,
            )}
            {...rest}
        />
    );
};
