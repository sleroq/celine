import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { CropEditor } from "../../../src/CropEditor";
import { accountApi, type Crop, type Photo } from "../../../src/api";
import "../../../src/style.css";

const source = document.createElement("canvas");
source.width = 800;
source.height = 400;
source.getContext("2d")!.fillRect(0, 0, 800, 400);
const calls: (Crop | null)[] = [];
Object.assign(window, { calls });
const api = {
    ...accountApi("fixture"),
    originalPhotoUrl: () => (location.search ? "/missing-crop-image" : source.toDataURL()),
    saveCrop: async (_id: string, crop: Crop | null) => {
        calls.push(crop);
    },
};
const photo: Photo = {
    id: "1",
    name: "Fixture",
    telegram_id: null,
    history_checked: true,
    crop: { x: 0.25, y: 0.125, size: 0.5 },
    emoji_status: null,
    appearance: { profile: null, name: null },
};
const refresh = async () => {};
function Fixture() {
    const [saving, setSaving] = createSignal(false);
    return (
        <div style={{ width: "600px" }} id="fixture">
            <CropEditor
                api={api}
                photo={photo}
                saving={saving()}
                setSaving={setSaving}
                refresh={refresh}
                close={() => {}}
            />
        </div>
    );
}
const dispose = render(() => <Fixture />, document.getElementById("root")!);
Object.assign(window, { dispose });
