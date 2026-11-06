// Adapted from shadcn-solid (MIT): https://github.com/hngngn/shadcn-solid
import { defineConfig } from "cva";
import { twMerge } from "tailwind-merge";

export const { cva, cx, compose } = defineConfig({
    hooks: {
        onComplete: (className) => twMerge(className),
    },
});
