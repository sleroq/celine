import { render } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { EmojiArtworkPreview } from "../../../src/EmojiArtworkPreview";
import { SortableList } from "../../../src/SortableList";
import "../../../src/style.css";
const url =
    "data:image/svg+xml," +
    encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="orange"/></svg>',
    );
function Fixture() {
    const [selected, setSelected] = createSignal("none");
    const [items, setItems] = createSignal(
        ["First", "Second"].map((id) => ({ id, label: id, mediaUrl: url })),
    );

    return (
        <>
            <div style={{ display: "flex", gap: "20px", padding: "40px" }}>
                <For each={["First", "Second"]}>
                    {(label) => (
                        <EmojiArtworkPreview enabled url={url} label={label}>
                            {(ref) => (
                                <button
                                    ref={ref}
                                    style={{ width: "100px", height: "80px" }}
                                    onClick={() => setSelected(label)}
                                >
                                    {label}
                                </button>
                            )}
                        </EmojiArtworkPreview>
                    )}
                </For>
            </div>
            <p id="selection">{selected()}</p>
            <SortableList
                kind="emoji"
                items={items()}
                busy={false}
                reorder={(ids) =>
                    setItems(ids.map((id) => items().find((item) => item.id === id)!))
                }
                remove={() => {}}
            />
            <p id="order">
                {items()
                    .map((i) => i.id)
                    .join(",")}
            </p>
        </>
    );
}
render(() => <Fixture />, document.getElementById("root")!);
