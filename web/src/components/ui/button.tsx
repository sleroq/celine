// Adapted from shadcn-solid (MIT): https://github.com/hngngn/shadcn-solid
import type { ComponentProps } from "@solidjs/web";
import { omit } from "solid-js";
import { Root as ButtonPrimitive } from "@kobalte/core/button";
import type { VariantProps } from "cva";

import { cva } from "../../lib/cva";

export const buttonVariants = cva({
    base: [
        "inline-flex items-center justify-center gap-2 whitespace-nowrap min-h-10 cursor-pointer rounded-md border-0 font-[inherit] font-semibold leading-tight transition-colors [&_svg:not([class*=size-])]:size-4 shrink-0 outline-none",
        "disabled:cursor-not-allowed disabled:opacity-55",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "aria-invalid:outline-danger",
    ],

    variants: {
        variant: {
            default: "bg-accent text-accent-foreground hover:brightness-90",
            secondary: "bg-muted text-foreground hover:bg-muted-hover",
            ghost: "bg-transparent text-foreground hover:bg-muted-hover",
        },
        size: {
            default: "px-3 py-2",
            sm: "px-2.5 py-2 text-sm",
            icon: "size-10 p-0",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});

export type ButtonProps = ComponentProps<typeof ButtonPrimitive<"button">> &
    VariantProps<typeof buttonVariants>;

export const Button = (props: ButtonProps) => {
    const rest = omit(
        props,
        (key) => key === "class" || key === "variant" || key === "size" || key === "type",
    );

    return (
        <ButtonPrimitive
            {...rest}
            type={props.type ?? "button"}
            data-slot="button"
            class={buttonVariants({
                variant: props.variant,
                size: props.size,
                class: props.class,
            })}
        />
    );
};
