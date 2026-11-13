#!/usr/bin/env bash
# Start Vite first: bun run dev --port 5179
set -euo pipefail
cd "$(dirname "$0")/../../.."
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix crop-test)"
trap 'agent-browser close >/dev/null' EXIT
agent-browser open http://127.0.0.1:5179/tests/browser/crop/
agent-browser wait --fn 'document.querySelector(".crop-stage")?.getAttribute("aria-busy") === "false"'
assert() {
    local result
    result=$(agent-browser eval "$1")
    if [[ "$result" != true ]]; then echo "Assertion failed: $1 ($result)" >&2; exit 1; fi
}
# Initial saved rectangle maps from natural pixels to the displayed image.
assert '(()=>{const s=document.querySelector("cropper-selection"),i=document.querySelector("cropper-image").$image.getBoundingClientRect(),c=document.querySelector("cropper-canvas").getBoundingClientRect();return Math.abs((s.x-(i.left-c.left))/i.width-.25)<.001 && Math.abs((s.y-(i.top-c.top))/i.height-.125)<.001 && Math.abs(s.width/i.height-.5)<.001})()'
agent-browser click 'button:last-child'
assert 'Math.abs(window.calls[0].x-.25)<.001 && Math.abs(window.calls[0].y-.125)<.001 && Math.abs(window.calls[0].size-.5)<.001'
# Reject out-of-bounds selection moves and clamp image moves to the crop.
assert '(()=>{const s=document.querySelector("cropper-selection"),x=s.x;s.$move(-1000,0);return s.x===x})()'
assert '(()=>{const i=document.querySelector("cropper-image"),m=i.$getTransform(),s=document.querySelector("cropper-selection"),c=document.querySelector("cropper-canvas").getBoundingClientRect();i.$move(1000,0);const r=i.$image.getBoundingClientRect(),ok=Math.abs(r.left-c.left-s.x)<.01;i.$setTransform(m);return ok})()'
# Valid selection changes update the saved normalized draft.
agent-browser eval 'document.querySelector("cropper-selection").$move(30, 0)'
agent-browser click 'button:last-child'
assert 'Math.abs(window.calls[1].x-.3)<.001'
# Resize keeps the draft and circular selection aligned with the image.
agent-browser eval 'document.querySelector("#fixture").style.width="400px"'
agent-browser wait --fn 'Math.abs(document.querySelector("cropper-canvas").getBoundingClientRect().width-400)<1'
agent-browser wait 100
assert '(()=>{const s=document.querySelector("cropper-selection"),i=document.querySelector("cropper-image").$image.getBoundingClientRect(),c=document.querySelector("cropper-canvas").getBoundingClientRect();return Math.abs((s.x-(i.left-c.left))/i.width-.3)<.001 && Math.abs(s.width-s.height)<.01 && getComputedStyle(s).borderRadius==="50%"})()'
agent-browser click 'button:first-child'
assert '(()=>{const s=document.querySelector("cropper-selection"),i=document.querySelector("cropper-image").$image.getBoundingClientRect(),c=document.querySelector("cropper-canvas").getBoundingClientRect();return Math.abs((s.x-(i.left-c.left))/i.width-.25)<.001 && Math.abs(s.width-i.height)<.01})()'
agent-browser click 'button:last-child'
assert 'window.calls[2] === null'
# At the top pan boundary, a diagonal upward drag must still move horizontally.
agent-browser eval '(()=>{const i=document.querySelector("cropper-image"),s=document.querySelector("cropper-selection");s.$change(120,100,100,100);const c=document.querySelector("cropper-canvas").getBoundingClientRect(),r=i.$image.getBoundingClientRect();i.$move(0,s.y+s.height-(r.bottom-c.top));window.topBoundary=i.$getTransform()})()'
assert '(()=>{const s=document.querySelector("cropper-selection"),r=document.querySelector("cropper-image").$image.getBoundingClientRect(),c=document.querySelector("cropper-canvas").getBoundingClientRect();return Math.abs(r.bottom-c.top-s.y-s.height)<.01 && r.left-c.left<s.x-15})()'
agent-browser mouse move 350 180
agent-browser mouse down
agent-browser mouse move 365 165 --steps 4
agent-browser mouse up
assert '(()=>{const i=document.querySelector("cropper-image"),m=i.$getTransform(),s=document.querySelector("cropper-selection"),r=i.$image.getBoundingClientRect(),c=document.querySelector("cropper-canvas").getBoundingClientRect();return m[4]>window.topBoundary[4]+10 && Math.abs(m[5]-window.topBoundary[5])<.01 && r.left-c.left<=s.x+.01 && r.right-c.left>=s.x+s.width-.01 && r.top-c.top<=s.y+.01 && r.bottom-c.top>=s.y+s.height-.01})()'
agent-browser click 'button:first-child'
# Drag the background to pan and use the wheel to zoom, then save what is displayed.
agent-browser eval 'document.querySelector("cropper-selection").$change(120,100,100,100)'
agent-browser eval 'window.beforePan = document.querySelector("cropper-image").$getTransform()'
agent-browser mouse move 350 180
agent-browser mouse down
agent-browser mouse move 365 190 --steps 4
agent-browser mouse up
assert 'document.querySelector("cropper-image").$getTransform().some((v,n)=>v!==window.beforePan[n])'
agent-browser eval 'window.beforeZoom = document.querySelector("cropper-image").$getTransform()'
agent-browser mouse wheel -120
agent-browser wait --fn 'document.querySelector("cropper-image").$getTransform()[0] > window.beforeZoom[0]'
agent-browser click 'button:last-child'
assert '(()=>{const s=document.querySelector("cropper-selection"),i=document.querySelector("cropper-image").$image.getBoundingClientRect(),c=document.querySelector("cropper-canvas").getBoundingClientRect(),v=window.calls.at(-1);return Math.abs(v.x-(s.x-(i.left-c.left))/i.width)<.0001 && Math.abs(v.y-(s.y-(i.top-c.top))/i.height)<.0001 && Math.abs(v.size-s.width/i.height)<.0001})()'
# Clamp image movement at the selection boundary.
assert '(()=>{const i=document.querySelector("cropper-image"),s=document.querySelector("cropper-selection"),c=document.querySelector("cropper-canvas").getBoundingClientRect();i.$move(10000,0);return Math.abs(i.$image.getBoundingClientRect().left-c.left-s.x)<.01})()'
# Resizing preserves the zoom and pan relative to the fitted view.
agent-browser eval '(()=>{const i=document.querySelector("cropper-image").$image.getBoundingClientRect(),c=document.querySelector("cropper-canvas").getBoundingClientRect();window.view={zoom:i.width/c.width,x:(i.left+i.width/2-c.left-c.width/2)/c.width,y:(i.top+i.height/2-c.top-c.height/2)/c.width}})()'
agent-browser eval 'document.querySelector("#fixture").style.width="500px"'
agent-browser wait --fn 'Math.abs(document.querySelector("cropper-canvas").clientWidth-500)<1'
agent-browser wait --fn '(()=>{const i=document.querySelector("cropper-image").$image.getBoundingClientRect(),c=document.querySelector("cropper-canvas").getBoundingClientRect();return Math.abs(i.width/c.width-window.view.zoom)<.001 && Math.abs((i.left+i.width/2-c.left-c.width/2)/c.width-window.view.x)<.001 && Math.abs((i.top+i.height/2-c.top-c.height/2)/c.width-window.view.y)<.001})()'
# A heavily zoomed view resets to the largest visible centered square, and clears the crop.
assert '(()=>{const i=document.querySelector("cropper-image"),before=i.$getTransform()[0];i.$zoom(2);return i.$getTransform()[0]>before*2.9})()'
agent-browser click 'button:first-child'
assert '(()=>{const s=document.querySelector("cropper-selection"),i=document.querySelector("cropper-image").$image.getBoundingClientRect(),c=document.querySelector("cropper-canvas").getBoundingClientRect();return s.width<=c.width && s.height<=c.height && Math.abs(s.width-i.height)<.01 && s.borderRadius==="50%" && document.querySelector("cropper-shade").borderRadius==="50%"})()'
agent-browser click 'button:last-child'
assert 'window.calls.at(-1) === null'
agent-browser eval 'window.dispose()'
assert '!document.querySelector("cropper-canvas") && !document.querySelector(".crop-stage")'
agent-browser open 'http://127.0.0.1:5179/tests/browser/crop/?error'
agent-browser wait --fn '!!document.querySelector("[role=alert]")'
assert 'document.querySelector(".crop-stage").getAttribute("aria-busy") === "false" && document.querySelector("button:last-child").disabled'
agent-browser eval 'window.dispose()'
assert '!document.querySelector("cropper-canvas")'
