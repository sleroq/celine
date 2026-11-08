import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { accountApi, moveItem, request, timeRemaining } from "../src/api";

describe("photo and emoji order", () => {
    test("moves photos to any position without mutating the server snapshot", () => {
        const photos = ["one", "two", "three", "four"];
        expect(moveItem(photos, 0, 3)).toEqual(["two", "three", "four", "one"]);
        expect(moveItem(photos, 3, 0)).toEqual(["four", "one", "two", "three"]);
        expect(moveItem(photos, 1, 2)).toEqual(["one", "three", "two", "four"]);
        expect(photos).toEqual(["one", "two", "three", "four"]);
    });
    test("preserves Telegram document IDs and the chosen emoji order", () => {
        const ids = ["9223372036854775806", "100", "200"];
        expect(moveItem(ids, 2, 1)).toEqual(["9223372036854775806", "200", "100"]);
    });
});

describe("rotation requests", () => {
    afterEach(() => mock.restore());

    test("sends independent photo and emoji settings to their own endpoints", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        const photo = {
            enabled: true,
            mode: "ordered" as const,
            interval_secs: 60,
            jitter_secs: null,
        };
        const emoji = {
            enabled: false,
            mode: "random" as const,
            interval_secs: 300,
            jitter_secs: 7,
        };
        const api = accountApi("personal");
        await api.request("settings", "PUT", photo);
        await api.request("emojis/settings", "PUT", emoji);
        expect(
            fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body]),
        ).toEqual([
            ["/api/accounts/personal/settings", "PUT", JSON.stringify(photo)],
            ["/api/accounts/personal/emojis/settings", "PUT", JSON.stringify(emoji)],
        ]);
    });

    test("saves emoji IDs in chosen order and allows clearing the selection", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        const api = accountApi("personal");
        await api.request("emojis", "PUT", { ids: ["200", "collectible:9223372036854775806"] });
        await api.request("emojis", "PUT", { ids: [] });
        expect(fetch.mock.calls.map(([, options]) => options?.body)).toEqual([
            JSON.stringify({ ids: ["200", "collectible:9223372036854775806"] }),
            JSON.stringify({ ids: [] }),
        ]);
    });
});

describe("request errors", () => {
    afterEach(() => mock.restore());

    test("uses structured server messages rather than English error text", async () => {
        spyOn(globalThis, "fetch").mockResolvedValue(
            Response.json(
                {
                    error: "Raw backend detail",
                    error_info: { code: "telegram.cooldown", params: { seconds: 42 } },
                },
                { status: 429 },
            ),
        );
        await expect(request("state")).rejects.toThrow(
            "Telegram requested a cooldown. Retry in 42 s.",
        );
    });

    test("handles non-JSON errors and network failures", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
            .mockRejectedValueOnce(new Error("browser-specific network error"));
        await expect(request("state")).rejects.toThrow("Request failed (503).");
        await expect(request("state")).rejects.toThrow("Cannot reach Celine.");
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe("account-scoped requests", () => {
    afterEach(() => mock.restore());

    test("clears all photo statuses even if one sync fails", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        await expect(accountApi("a/b").clearPhotoEmojis(["first", "second"])).rejects.toThrow(
            "Request failed (503).",
        );
        expect(fetch.mock.calls.map(([url, options]) => [url, options?.body])).toEqual([
            ["/api/accounts/a%2Fb/photos/first/emoji-status", JSON.stringify({ id: null })],
            ["/api/accounts/a%2Fb/photos/second/emoji-status", JSON.stringify({ id: null })],
        ]);
    });

    test("clears all photo appearances even if one write fails", async () => {
        const fetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        await expect(accountApi("a/b").clearPhotoAppearances(["first", "second"])).rejects.toThrow(
            "Request failed (503).",
        );
        expect(fetch.mock.calls.map(([url, options]) => [url, options?.body])).toEqual([
            [
                "/api/accounts/a%2Fb/photos/first/appearance",
                JSON.stringify({ profile: null, name: null }),
            ],
            [
                "/api/accounts/a%2Fb/photos/second/appearance",
                JSON.stringify({ profile: null, name: null }),
            ],
        ]);
    });

    test("keeps settings, login, and delayed work bound to the original account", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        const personal = accountApi("personal");
        const work = accountApi("work");
        const settings = {
            enabled: false,
            mode: "ordered" as const,
            interval_secs: 60,
            jitter_secs: null,
        };
        function savePersonal() {
            return personal.request("settings", "PUT", settings);
        }
        const logoutPersonal = personal.logout;
        await work.activate();
        await savePersonal();
        await work.request("auth/qr", "POST");
        await personal.request("auth/password", "POST", { password: "test-password" });
        await logoutPersonal();
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
            "/api/accounts/work/active",
            "/api/accounts/personal/settings",
            "/api/accounts/work/auth/qr",
            "/api/accounts/personal/auth/password",
            "/api/accounts/personal",
        ]);
    });

    test("creates accounts and logs out only the specified account", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        await request("accounts", "POST");
        await accountApi("personal").logout();
        expect(fetch.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
            ["/api/accounts", "POST"],
            ["/api/accounts/personal", "DELETE"],
        ]);
    });

    test("requests an asynchronous account-scoped photo cache refresh", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        await accountApi("a/b").request("photos/history/refresh", "POST");
        expect(
            fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body]),
        ).toEqual([["/api/accounts/a%2Fb/photos/history/refresh", "POST", undefined]]);
    });

    test("selects Telegram history photos without losing ID precision", async () => {
        const id = "9223372036854775806";
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        const api = accountApi("a/b");
        await api.request("photos/history", "POST", { id });
        await api.request("photos/local-id", "DELETE");
        expect(
            fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body]),
        ).toEqual([
            ["/api/accounts/a%2Fb/photos/history", "POST", JSON.stringify({ id })],
            ["/api/accounts/a%2Fb/photos/local-id", "DELETE", undefined],
        ]);
        expect(api.photoHistoryUrl(id)).toBe(`/api/accounts/a%2Fb/photos/history/${id}`);
        expect(api.photoHistoryUrl("x/y")).toBe("/api/accounts/a%2Fb/photos/history/x%2Fy");
    });

    test("selected previews use crop-specific keys for local and Telegram photos", () => {
        const api = accountApi("a/b");
        const local = { id: "local/id", crop: null };
        const cropped = { ...local, crop: { x: 0.1, y: 0.2, size: 0.5 } };
        expect(api.selectedPhotoUrl(local)).toBe("/api/accounts/a%2Fb/photos/local%2Fid?crop=null");
        expect(api.selectedPhotoUrl(cropped)).toBe(
            `${api.photoUrl(local.id)}?crop=${encodeURIComponent(JSON.stringify(cropped.crop))}`,
        );
        expect(api.originalPhotoUrl(local.id)).toBe(
            "/api/accounts/a%2Fb/photos/local%2Fid/original",
        );
        expect(accountApi("other").selectedPhotoUrl(cropped)).not.toBe(
            api.selectedPhotoUrl(cropped),
        );
    });

    test("queues a saved photo for upload in the correct account", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        await accountApi("a/b").reuploadPhoto("p/q");
        expect(
            fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body]),
        ).toEqual([["/api/accounts/a%2Fb/photos/p%2Fq/reupload", "POST", undefined]]);
    });

    test("assigns and clears photo emoji statuses on the original account with opaque IDs", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        const api = accountApi("account/one");
        const choice = "collectible:9223372036854775806";
        await api.savePhotoEmoji("photo/one", choice);
        await api.savePhotoEmoji("photo/one", null);
        expect(
            fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body]),
        ).toEqual([
            [
                "/api/accounts/account%2Fone/photos/photo%2Fone/emoji-status",
                "PUT",
                JSON.stringify({ id: choice }),
            ],
            [
                "/api/accounts/account%2Fone/photos/photo%2Fone/emoji-status",
                "PUT",
                JSON.stringify({ id: null }),
            ],
        ]);
    });

    test("saves and resets crop on the account-scoped photo", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        const api = accountApi("a/b");
        const crop = { x: 0.1, y: 0.2, size: 0.5 };
        await api.saveCrop("p/q", crop);
        await api.saveCrop("p/q", null);
        expect(
            fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body]),
        ).toEqual([
            ["/api/accounts/a%2Fb/photos/p%2Fq/crop", "PUT", JSON.stringify({ crop })],
            ["/api/accounts/a%2Fb/photos/p%2Fq/crop", "PUT", JSON.stringify({ crop: null })],
        ]);
    });

    test("encodes account and media IDs without losing 64-bit precision", () => {
        const api = accountApi("a/b?c");
        expect(api.photoUrl("d/e?f")).toBe("/api/accounts/a%2Fb%3Fc/photos/d%2Fe%3Ff");
        expect(api.emojiMediaUrl("9223372036854775806")).toBe(
            "/api/accounts/a%2Fb%3Fc/emojis/9223372036854775806/media",
        );
        expect(api.emojiMediaUrl("d/e?f")).toBe("/api/accounts/a%2Fb%3Fc/emojis/d%2Fe%3Ff/media");
        expect(accountApi("personal").emojiMediaUrl("100")).not.toBe(
            accountApi("work").emojiMediaUrl("100"),
        );
    });
});

test("formats second timestamps and expired countdowns", () => {
    const minutes = new Intl.NumberFormat("en", {
        style: "unit",
        unit: "minute",
        unitDisplay: "short",
    });
    const seconds = new Intl.NumberFormat("en", {
        style: "unit",
        unit: "second",
        unitDisplay: "short",
    });
    expect(timeRemaining(165, 100)).toBe(`${minutes.format(1)} ${seconds.format(5)}`);
    expect(timeRemaining(120, 100.1)).toBe(seconds.format(20));
    expect(timeRemaining(90, 100)).toBe(seconds.format(0));
});

describe("appearance requests", () => {
    afterEach(() => mock.restore());

    test("preserves unchanged sections, explicit resets and eligible icons on account-scoped writes", async () => {
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 204 }),
        );

        const api = accountApi("personal");
        const reset = { profile: null, name: { color: null, emoji: null } };
        const custom = {
            profile: {
                color: 4,
                emoji: { id: "9223372036854775806", label: "Star", source: "Background" },
            },
            name: null,
        };

        await api.request("appearance/apply", "PUT", reset);
        await api.request("photos/photo%201/appearance", "PUT", custom);
        await api.request("appearance/presets", "PUT", { presets: [reset, custom] });
        const settings = {
            enabled: false,
            mode: "ordered" as const,
            interval_secs: 60,
            jitter_secs: null,
        };
        await api.request("appearance/settings", "PUT", settings);
        for (const action of ["start", "stop", "apply"])
            await api.request(`appearance/settings/${action}`, "POST");

        expect(
            fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body]),
        ).toEqual([
            ["/api/accounts/personal/appearance/apply", "PUT", JSON.stringify(reset)],
            ["/api/accounts/personal/photos/photo%201/appearance", "PUT", JSON.stringify(custom)],
            [
                "/api/accounts/personal/appearance/presets",
                "PUT",
                JSON.stringify({ presets: [reset, custom] }),
            ],
            ["/api/accounts/personal/appearance/settings", "PUT", JSON.stringify(settings)],
            ...["start", "stop", "apply"].map((action) => [
                `/api/accounts/personal/appearance/settings/${action}`,
                "POST",
                undefined,
            ]),
        ]);
    });
});
