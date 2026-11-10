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
