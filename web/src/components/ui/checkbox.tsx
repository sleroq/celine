// Adapted from shadcn-solid (MIT): https://github.com/hngngn/shadcn-solid
import type { ComponentProps } from "@solidjs/web";
import { omit } from "solid-js";
import { Checkbox as CheckboxPrimitive } from "@kobalte/core/checkbox";

import { cx } from "../../lib/cva";

export type CheckboxProps = ComponentProps<typeof CheckboxPrimitive<"div">>;

export const Checkbox = (props: CheckboxProps) => {
    return <CheckboxPrimitive data-slot="checkbox" {...props} />;
};

export type CheckboxLabelProps = ComponentProps<typeof CheckboxPrimitive.Label<"label">>;

export const CheckboxLabel = (props: CheckboxLabelProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <CheckboxPrimitive.Label
            data-slot="checkbox-label"
            class={cx(
                "flex items-center gap-2 text-sm leading-none font-medium select-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
                "data-invalid:text-danger",
                props.class,
            )}
            {...rest}
        />
    );
};

export type CheckboxInputProps = ComponentProps<typeof CheckboxPrimitive.Input<"input">>;

export const CheckboxInput = (props: CheckboxInputProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <CheckboxPrimitive.Input
            data-slot="checkbox-input"
            class={cx("peer", props.class)}
            {...rest}
        />
    );
};

export type CheckboxControlProps = ComponentProps<typeof CheckboxPrimitive.Control<"div">>;

export const CheckboxControl = (props: CheckboxControlProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <CheckboxPrimitive.Control
            data-slot="checkbox-control"
            class={cx(
                "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring bg-muted text-foreground data-checked:bg-accent data-checked:text-accent-foreground data-invalid:outline-2 data-invalid:outline-danger flex size-4 shrink-0 items-center justify-center rounded-sm border-0 outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
                props.class,
            )}
            {...rest}
        >
            <CheckboxPrimitive.Indicator
                data-slot="checkbox-indicator"
                class="flex items-center justify-center text-current transition-none"
            >
                <svg
                    aria-hidden="true"
                    xmlns="http://www.w3.org/2000/svg"
                    class="size-3.5"
                    viewBox="0 0 24 24"
                >
                    <path
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M20 6L9 17l-5-5"
                    />
                </svg>
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Control>
    );
};
