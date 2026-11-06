// Adapted from shadcn-solid (MIT): https://github.com/hngngn/shadcn-solid
import type { ComponentProps } from "@solidjs/web";
import { omit } from "solid-js";

import { cx } from "../../lib/cva";

export type CardProps = ComponentProps<"div">;

export const Card = (props: CardProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <div
            data-slot="card"
            class={cx(
                "bg-surface text-foreground flex flex-col gap-6 rounded-xl py-6",
                props.class,
            )}
            {...rest}
        />
    );
};

export type CardHeaderProps = ComponentProps<"div">;

export const CardHeader = (props: CardHeaderProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <div
            data-slot="card-header"
            class={cx(
                "grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6",
                props.class,
            )}
            {...rest}
        />
    );
};

export type CardTitleProps = ComponentProps<"div">;

export const CardTitle = (props: CardTitleProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <div
            data-slot="card-title"
            class={cx("leading-none font-semibold", props.class)}
            {...rest}
        />
    );
};

export type CardDescriptionProps = ComponentProps<"div">;

export const CardDescription = (props: CardDescriptionProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <div
            data-slot="card-description"
            class={cx("text-muted-foreground text-sm", props.class)}
            {...rest}
        />
    );
};

export type CardContentProps = ComponentProps<"div">;

export const CardContent = (props: CardContentProps) => {
    const rest = omit(props, (key) => key === "class");

    return <div data-slot="card-content" class={cx("px-6", props.class)} {...rest} />;
};

export type CardFooterProps = ComponentProps<"div">;

export const CardFooter = (props: CardFooterProps) => {
    const rest = omit(props, (key) => key === "class");

    return (
        <div
            data-slot="card-footer"
            class={cx("flex items-center gap-2 px-6", props.class)}
            {...rest}
        />
    );
};
