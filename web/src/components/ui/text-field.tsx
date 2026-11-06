// Adapted from shadcn-solid (MIT): https://github.com/hngngn/shadcn-solid
import type { ComponentProps } from "@solidjs/web";
import { omit } from "solid-js";
import { TextField as TextFieldPrimitive } from "@kobalte/core/text-field";

import { cx } from "../../lib/cva";

export type TextFieldProps = ComponentProps<typeof TextFieldPrimitive<"div">>;

export const TextField = (props: TextFieldProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <TextFieldPrimitive
            data-slot="text-field"
            class={cx("grid w-full gap-2", props.class)}
            {...rest}
        />
    );
};

export type TextFieldInputProps = ComponentProps<typeof TextFieldPrimitive.Input<"input">>;

export const TextFieldInput = (props: TextFieldInputProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <TextFieldPrimitive.Input
            data-slot="text-field-input"
            class={cx(
                "placeholder:text-muted-foreground selection:bg-accent selection:text-accent-foreground flex min-h-10 w-full rounded-md border-0 bg-muted px-3 py-2 text-base text-foreground transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-55",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                "aria-invalid:outline-danger",
                "file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
                props.class,
            )}
            {...rest}
        />
    );
};

export type TextFieldLabelProps = ComponentProps<typeof TextFieldPrimitive.Label<"label">>;

export const TextFieldLabel = (props: TextFieldLabelProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <TextFieldPrimitive.Label
            data-slot="text-field-label"
            class={cx(
                "text-sm font-medium select-none",
                "data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
                "data-invalid:text-danger",
                props.class,
            )}
            {...rest}
        />
    );
};
