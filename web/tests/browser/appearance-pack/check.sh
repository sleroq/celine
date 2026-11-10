#!/usr/bin/env bash
# Start Vite first: cd web && bun run dev --port 5178
set -euo pipefail
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix appearance-pack-test)"
trap 'agent-browser close >/dev/null' EXIT
assert() {
    local result
    result=$(agent-browser eval "$1")
    if [[ "$result" != true ]]; then echo "Assertion failed: $1 ($result)" >&2; exit 1; fi
}
for mode in '' '?internal'; do
    agent-browser open "http://127.0.0.1:5178/tests/browser/appearance-pack/$mode" >/dev/null
    agent-browser wait 'fieldset button[aria-expanded]' >/dev/null
    agent-browser click 'fieldset:nth-of-type(1) button[aria-expanded]' >/dev/null
    agent-browser click 'fieldset:nth-of-type(1) nav button[title="Nature"]' >/dev/null
    agent-browser wait '[role="alert"]' >/dev/null
    assert 'document.querySelectorAll("[role=alert]").length === 1 && document.querySelector("[role=alert]").textContent === "Pack unavailable" && window.calls.packs === 1'
    agent-browser click 'fieldset:nth-of-type(1) .emoji-pack-choices button' >/dev/null
    agent-browser wait 'input[aria-label="Leaf (Nature)"]' >/dev/null
    agent-browser click 'fieldset:nth-of-type(2) button[aria-expanded]' >/dev/null
    assert '!!document.querySelector("fieldset:nth-of-type(2) input[aria-label=\"Default (Default)\"]")'
    agent-browser click 'fieldset:nth-of-type(2) nav button[title="Nature"]' >/dev/null
    assert 'document.querySelectorAll("input[aria-label=\"Leaf (Nature)\"]").length === 2 && window.calls.packs === 2'
    if [[ -n "$mode" ]]; then assert 'window.calls.catalog === 1'; else assert 'window.calls.catalog === 0'; fi
done
