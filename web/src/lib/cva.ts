// Adapted from shadcn-solid (MIT): https://github.com/hngngn/shadcn-solid
import * as classes from "cva";
import type { ClassValue } from "cva";
import { defineConfig } from "cva/config";
import { twMerge } from "tailwind-merge";

export const { cva, cx } = defineConfig({
    cx: (...inputs: ClassValue[]) => twMerge(classes.cx(...inputs)),
});
