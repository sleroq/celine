import { Tooltip as TooltipPrimitive } from "@kobalte/core/tooltip";
import type { JSX } from "@solidjs/web";

export function Tooltip(props: { children: JSX.Element }) {
    return (
        <TooltipPrimitive openDelay={300} closeDelay={0} placement="top" gutter={8}>
            {props.children}
        </TooltipPrimitive>
    );
}

export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent(props: { children: JSX.Element }) {
    return (
        <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content class="pointer-events-none z-50 max-w-64 rounded-md border border-border bg-surface px-2 py-1 text-sm font-normal text-foreground shadow-lg">
                {props.children}
            </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
    );
}
