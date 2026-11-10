// Adapted from shadcn-solid (MIT): https://github.com/hngngn/shadcn-solid
import type { ComponentProps, ValidComponent } from "@solidjs/web";
import type { VoidProps } from "solid-js";
import { omit } from "solid-js";
import { Select as SelectPrimitive } from "@kobalte/core/select";

import { cx } from "../../lib/cva";

export type SelectProps<Option, OptGroup = never> = ComponentProps<
    typeof SelectPrimitive<Option, OptGroup, "div">
>;

export const Select = <Option, OptGroup = never>(props: SelectProps<Option, OptGroup>) => {
    const rest = omit(props, "class");

    // Inline content starts at the trigger, so listbox autofocus cannot scroll the page to a portal's origin.
    return (
        <SelectPrimitive<Option, OptGroup>
            data-slot="select"
            placement="bottom-start"
            gutter={4}
            class={cx("relative grid w-full gap-2", props.class)}
            {...rest}
        />
    );
};

export type SelectValueProps<Options> = ComponentProps<
    typeof SelectPrimitive.Value<Options, "span">
>;

export const SelectValue = <Options,>(props: SelectValueProps<Options>) => {
    return <SelectPrimitive.Value data-slot="select-value" {...props} />;
};

export type SelectTriggerProps = ComponentProps<typeof SelectPrimitive.Trigger<"button">>;

export const SelectTrigger = (props: SelectTriggerProps) => {
    const rest = omit(props, "class", "children");

    return (
        <SelectPrimitive.Trigger
            data-slot="select-trigger"
            class={cx(
                "data-placeholder:text-muted-foreground flex w-full items-center justify-between gap-2 rounded-md border-0 bg-muted-hover/60 px-3 py-2 text-sm text-foreground whitespace-nowrap transition-colors outline-none hover:bg-muted-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-invalid:outline-danger disabled:cursor-not-allowed disabled:opacity-50 min-h-10 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
                props.class,
            )}
            {...rest}
        >
            {props.children}
            <SelectPrimitive.Icon<ValidComponent>
                class="size-4 opacity-50"
                as={(props) => (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" {...props}>
                        <path
                            fill="none"
                            stroke="currentColor"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="m6 9l6 6l6-6"
                        />
                    </svg>
                )}
            />
        </SelectPrimitive.Trigger>
    );
};

export type SelectContentProps = VoidProps<ComponentProps<typeof SelectPrimitive.Content<"div">>>;

export const SelectContent = (props: SelectContentProps) => {
    const rest = omit(props, "class");

    return (
        <SelectPrimitive.Content
            data-slot="select-content"
            class={cx(
                "relative z-50 min-w-32 max-h-80 origin-(--kb-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border-0 bg-[color-mix(in_srgb,var(--ui-surface)_50%,var(--ui-muted-hover))] text-foreground shadow-lg",
                props.class,
            )}
            {...rest}
        >
            <SelectPrimitive.Listbox class="m-0 list-none p-1 outline-none" />
        </SelectPrimitive.Content>
    );
};

export type SelectItemProps = ComponentProps<typeof SelectPrimitive.Item<"li">>;

export const SelectItem = (props: SelectItemProps) => {
    const rest = omit(props, "class", "children");

    return (
        <SelectPrimitive.Item
            data-slot="select-item"
            class={cx(
                "relative flex w-full cursor-default items-center justify-between gap-2 rounded-sm px-2 py-2 text-sm outline-none select-none data-highlighted:bg-muted-hover data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
                props.class,
            )}
            {...rest}
        >
            <SelectPrimitive.ItemLabel>{props.children}</SelectPrimitive.ItemLabel>
            <SelectPrimitive.ItemIndicator<ValidComponent>
                class="size-3.5 text-accent"
                as={(props) => (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" {...props}>
                        <path
                            fill="none"
                            stroke="currentColor"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M20 6L9 17l-5-5"
                        />
                    </svg>
                )}
            />
        </SelectPrimitive.Item>
    );
};

export type SelectLabelProps = ComponentProps<typeof SelectPrimitive.Label<"label">>;

export const SelectLabel = (props: SelectLabelProps) => {
    const rest = omit(props, "class");

    return (
        <SelectPrimitive.Label
            data-slot="select-label"
            class={cx(
                "flex items-center gap-2 text-sm leading-none font-medium select-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
                props.class,
            )}
            {...rest}
        />
    );
};
