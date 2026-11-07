import type { EmojiAnimation } from "./emoji-media";

export function emojiRenderer(animation: EmojiAnimation, textColor?: boolean): "svg" | "canvas" {
    // SVG CSS preserves inherited currentColor for text-color emoji.
    if (textColor) return "svg";
    // Canvas masks lack SVG's mode and opacity support. Check all precomp assets,
    // including nested precomps, without walking unrelated shape/property trees.
    if (hasActiveMasks(animation) || animation.assets?.some(hasActiveMasks)) return "svg";
    return "canvas";
}

function hasActiveMasks(composition: EmojiAnimation): boolean {
    return (
        composition.layers?.some((layer) =>
            layer.masksProperties?.some((mask) => mask.mode !== "n"),
        ) ?? false
    );
}
