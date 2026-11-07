import assert from "node:assert/strict";
import { createMemo, createRoot, flush } from "solid-js";
import { accountApi } from "../../src/api";
import { createEmojiPacks } from "../../src/emoji-packs";

const recent = { id: "100", label: "⭐", source: "Recent", source_kind: "recent" };
const leaf = { id: "200", label: "🌿", source: "Nature" };
const replies = [
    { choices: [recent], sets: [], premium: true },
    { choices: [leaf] },
    { choices: [{ ...recent, label: "✨" }], sets: [], premium: true },
];
globalThis.fetch = Object.assign(async () => Response.json(replies.shift()), {
    preconnect: globalThis.fetch.preconnect,
});

const packs = createEmojiPacks(accountApi("account-a"));
let dispose!: () => void;
const found = createRoot((end) => {
    dispose = end;
    const recentLabel = createMemo(() => packs.find(recent.id)?.label);
    const leafLabel = createMemo(() => packs.find(leaf.id)?.label);
    return { recent: recentLabel, leaf: leafLabel };
});

assert.equal(found.recent(), undefined);
assert.equal(found.leaf(), undefined);
await packs.select();
flush();
assert.equal(found.recent(), recent.label);
assert.equal(found.leaf(), undefined);
await packs.select("2000");
flush();
assert.equal(found.leaf(), leaf.label);
await packs.select("");
flush();
assert.equal(found.recent(), "✨");
dispose();
