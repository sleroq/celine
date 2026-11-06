import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
    size?: "default" | "sm" | "icon";
};

const variants = {
    default: "bg-accent text-accent-foreground hover:brightness-90",
    secondary: "bg-muted text-foreground hover:bg-muted-hover",
    outline:
        "border border-solid border-border bg-transparent text-foreground hover:bg-muted-hover",
    ghost: "bg-transparent text-foreground hover:bg-muted-hover",
    destructive: "bg-danger text-danger-foreground hover:brightness-90",
};

const sizes = {
    default: "px-3 py-2",
    sm: "px-2.5 py-2 text-sm",
    icon: "w-10 p-0",
};

export function Button(props: ButtonProps) {
    const rest = omit(
        props,
        (key) => key === "variant" || key === "size" || key === "class" || key === "type",
    );
    return (
        <button
            {...rest}
            type={props.type ?? "button"}
            class={[
                "inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-md border-0 font-[inherit] font-semibold leading-tight whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-55",
                variants[props.variant ?? "default"],
                sizes[props.size ?? "default"],
                props.class,
            ]}
        />
    );
}
