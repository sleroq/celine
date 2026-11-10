#!/usr/bin/env bash
# Start Vite first: cd web && bun run dev --port 5178
set -euo pipefail
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix account-save-test)"
trap 'agent-browser close >/dev/null' EXIT
assert() {
    local result
    result=$(agent-browser eval "$1")
    if [[ "$result" != true ]]; then echo "Assertion failed: $1 ($result)" >&2; exit 1; fi
}
agent-browser open http://127.0.0.1:5178/tests/browser/account-save/ >/dev/null
agent-browser wait '#photo-interval' >/dev/null
agent-browser fill '#photo-interval' 2 >/dev/null
agent-browser wait --text 'Retry saving: Photo rotation' >/dev/null
agent-browser click '.account-trigger' >/dev/null
agent-browser wait '.account-switch:not(:disabled)' >/dev/null
agent-browser focus '.account-switch' >/dev/null
agent-browser press Enter >/dev/null
agent-browser wait --fn 'document.querySelector(".account-trigger")?.ariaLabel === "Manage accounts: Running account"' >/dev/null
agent-browser wait --fn 'window.writes.length === 2' >/dev/null
assert 'window.writes.every(w => w.url === `/api/accounts/${window.stoppedId}/settings` && JSON.parse(w.body).enabled === false && JSON.parse(w.body).interval_secs === 7200)'
assert '![...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Retry saving")) && document.querySelector("#photo-interval").value === "20"'
agent-browser fill '#photo-interval' 21 >/dev/null
agent-browser wait --fn 'window.writes.length === 3' >/dev/null
assert 'window.writes[2].url === `/api/accounts/${window.runningId}/settings` && JSON.parse(window.writes[2].body).enabled === true && JSON.parse(window.writes[2].body).interval_secs === 1260'
agent-browser click '.account-trigger' >/dev/null
agent-browser wait '.account-switch:not(:disabled)' >/dev/null
agent-browser focus '.account-switch' >/dev/null
agent-browser press Enter >/dev/null
agent-browser wait --fn 'document.querySelector(".account-trigger")?.ariaLabel === "Manage accounts: Stopped account"' >/dev/null
assert 'document.querySelector("#photo-interval").value === "2" && [...document.querySelectorAll("#photos-panel button")].some(b => b.textContent === "Start rotation")'
