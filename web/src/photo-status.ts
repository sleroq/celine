import type { Photo, State } from "./api";

export function photoMatchMessage(
    photo: Pick<Photo, "id" | "telegram_id" | "history_checked">,
    cache: State["photo_cache"],
) {
    if (photo.telegram_id != null && cache.photos.some((item) => item.id === photo.telegram_id))
        return "photoReusable";
    if (photo.telegram_id != null && cache.status === "ready")
        return cache.recovery[photo.id]?.duplicate_of ? "photoDuplicate" : "photoUnavailable";
    if (photo.telegram_id == null && photo.history_checked && cache.status === "ready")
        return "photoUploadNew";
    return cache.status === "refreshing" ? "photoChecking" : "photoUnknown";
}
