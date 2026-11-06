import { createEffect, Show } from "solid-js";
import type { Profile } from "./api";
import { EmojiMedia } from "./EmojiMedia";

export function ProfileHeader(props: { profile?: Profile | null; name: string; now: number }) {
    const emoji = () => {
        const current = props.profile?.emoji;
        return current && (current.expires_at == null || current.expires_at > props.now)
            ? current
            : undefined;
    };

    const name = () => props.profile?.name ?? props.name;

    return (
        <span class="profile">
            <Show
                when={props.profile?.photo_url}
                fallback={
                    <span class="avatar avatar-placeholder" aria-hidden="true">
                        {name().slice(0, 1).toLocaleUpperCase()}
                    </span>
                }
            >
                {(url) => (
                    <ProfileImage
                        class="avatar"
                        url={url()}
                        label=""
                        revision={props.profile?.updated_at}
                    />
                )}
            </Show>
            <span class="profile-name" title={name()}>
                {name()}
            </span>
            <Show when={emoji()}>
                {(current) => (
                    <span class="profile-emoji">
                        <EmojiMedia
                            url={current().media_url}
                            label={current().label}
                            textColor={current().text_color}
                            revision={props.profile?.updated_at}
                        />
                    </span>
                )}
            </Show>
        </span>
    );
}

type ProfileMedia = { url: string; label: string; revision?: number };

function ProfileImage(props: ProfileMedia & { class?: string }) {
    let image!: HTMLImageElement;
    let failed = false;
    createEffect(
        () => ({ url: props.url, revision: props.revision }),
        ({ url, revision }, previous) => {
            if (url !== previous?.url || (failed && revision !== previous?.revision)) {
                failed = false;
                image.src = url;
            }
        },
    );
    return (
        <img
            class={props.class}
            alt={props.label}
            draggable="false"
            onError={() => {
                failed = true;
            }}
            ref={(element) => {
                image = element;
            }}
        />
    );
}
