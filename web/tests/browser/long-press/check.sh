#!/usr/bin/env bash
# Start Vite first: bun run dev --port 5178
set -euo pipefail
cd "$(dirname "$0")/../../.."
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix long-press-test)"
trap 'agent-browser close >/dev/null' EXIT
agent-browser open http://127.0.0.1:5178/tests/browser/long-press/
assert() {
    local result
    result=$(agent-browser eval "$1")
    if [[ "$result" != true ]]; then echo "Assertion failed: $1 ($result)" >&2; exit 1; fi
}
for row in 80 290; do
    for release in target outside; do
        agent-browser mouse move 90 "$row"
        if [[ "$row" == 290 ]]; then agent-browser mouse move 30 "$row"; fi
        agent-browser mouse down
        # Deliberately exceed the real component's 500ms hold threshold.
        sleep 0.7
        assert 'document.querySelector(".emoji-artwork-preview [role=img]")?.ariaLabel === "First"'
        if [[ "$row" == 80 ]]; then x=210; else x=90; fi
        agent-browser mouse move "$x" "$row"
        assert 'document.querySelector(".emoji-artwork-preview [role=img]")?.ariaLabel === "Second"'
        if [[ "$release" == outside ]]; then agent-browser mouse move 600 400; fi
        agent-browser mouse up
        assert 'document.querySelectorAll(".emoji-artwork-preview").length === 0 && document.querySelector("#selection").textContent === "none" && [...document.querySelectorAll(".sortable-handle")].every(b=>b.ariaPressed === "false") && document.querySelector("#order").textContent === "First,Second"'
    done
done
agent-browser click 'button:first-child'
assert 'document.querySelector("#selection").textContent === "First"'
agent-browser click '.sortable-handle'
assert 'document.querySelector(".sortable-handle").ariaPressed === "true"'
agent-browser click '.sortable-item:nth-child(2) .sortable-handle'
assert 'document.querySelector("#order").textContent === "Second,First"'
sleep 0.5 # Allow Sortable's reorder animation to finish before dragging again.
agent-browser mouse move 30 290
agent-browser mouse down
agent-browser mouse move 45 290 --steps 5 --duration 100
agent-browser mouse move 110 290 --steps 12 --duration 350
sleep 0.3
agent-browser mouse up
assert 'document.querySelector("#order").textContent === "First,Second" && !document.querySelector(".emoji-artwork-preview")'
