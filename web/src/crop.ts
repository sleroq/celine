import type { Crop } from "./api";

export type Dimensions = { width: number; height: number };
export type CropPixels = { x: number; y: number; width: number; height: number };

export function centeredCrop({ width, height }: Dimensions): Crop {
    const side = Math.min(width, height);
    return { x: (width - side) / 2 / width, y: (height - side) / 2 / height, size: 1 };
}

export function cropToPixels(crop: Crop, { width, height }: Dimensions): CropPixels {
    const side = crop.size * Math.min(width, height);
    return { x: crop.x * width, y: crop.y * height, width: side, height: side };
}

export function cropFromPixels(crop: CropPixels, { width, height }: Dimensions): Crop {
    return { x: crop.x / width, y: crop.y / height, size: crop.width / Math.min(width, height) };
}
