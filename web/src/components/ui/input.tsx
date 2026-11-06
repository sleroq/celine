import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";

const field =
    "block min-h-10 w-full min-w-0 rounded-md border border-solid border-border bg-surface px-3 py-2 font-[inherit] text-foreground placeholder:text-muted-foreground placeholder:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-55";

export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
    const rest = omit(props, (key) => key === "class");
    return <input {...rest} class={[field, props.class]} />;
}

export function Textarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    const rest = omit(props, (key) => key === "class");
    return <textarea {...rest} class={[field, "min-h-24 resize-y", props.class]} />;
}

export function Label(props: JSX.LabelHTMLAttributes<HTMLLabelElement>) {
    const rest = omit(props, (key) => key === "class");
    return <label {...rest} class={["text-sm font-semibold", props.class]} />;
}
