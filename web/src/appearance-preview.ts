function hex(color: number) {
    return `#${color.toString(16).padStart(6, "0")}`;
}

export function swatchFill(colors: number[]): string {
    if (!colors.length) return "transparent";
    if (colors.length === 1) return hex(colors[0]);
    const stops = colors.map(
        (color, index) =>
            `${hex(color)} ${(index / colors.length) * 100}% ${((index + 1) / colors.length) * 100}%`,
    );
    return `linear-gradient(135deg, ${stops.join(", ")})`;
}

export function replyAccent(colors: number[]): string | undefined {
    if (!colors.length) return undefined;
    if (colors.length === 1) return hex(colors[0]);
    const stops = colors.map((color, index) => `${hex(color)} ${index * 5}px ${(index + 1) * 5}px`);
    return `repeating-linear-gradient(135deg, ${stops.join(", ")})`;
}

export function profileBackground(colors: number[]): string | undefined {
    if (!colors.length) return undefined;
    if (colors.length === 1) return hex(colors[0]);
    return `radial-gradient(ellipse 140px 110px at 50% 72px, ${hex(colors[1])}, ${hex(colors[0])})`;
}
