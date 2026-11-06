import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";

export function Card(props: JSX.HTMLAttributes<HTMLDivElement>) {
    const rest = omit(props, (key) => key === "class");
    return <div {...rest} class={["rounded-[0.625rem] bg-surface text-foreground", props.class]} />;
}

export function CardHeader(props: JSX.HTMLAttributes<HTMLDivElement>) {
    const rest = omit(props, (key) => key === "class");
    return <div {...rest} class={["p-4 pb-0", props.class]} />;
}

export function CardTitle(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
    const rest = omit(props, (key) => key === "class");
    return <h3 {...rest} class={["m-0 text-base font-semibold", props.class]} />;
}

export function CardDescription(props: JSX.HTMLAttributes<HTMLParagraphElement>) {
    const rest = omit(props, (key) => key === "class");
    return <p {...rest} class={["mt-1.5 mb-0 text-sm text-muted-foreground", props.class]} />;
}

export function CardContent(props: JSX.HTMLAttributes<HTMLDivElement>) {
    const rest = omit(props, (key) => key === "class");
    return <div {...rest} class={["p-4", props.class]} />;
}

export function CardFooter(props: JSX.HTMLAttributes<HTMLDivElement>) {
    const rest = omit(props, (key) => key === "class");
    return <div {...rest} class={["flex items-center gap-2 p-4 pt-0", props.class]} />;
}
