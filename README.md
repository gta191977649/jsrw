# GTA Map Renderer (React + Vite + Three.js)

Prototype renderer that parses `gta.dat`, loads referenced `IDE` + `IPL`, and renders placed world objects by loading matching `.dff` + `.txd` using [`dff-loader`](https://github.com/Jackal1337/DFF-Loader).

UI is built with [`imgui-js`](https://github.com/flyover/imgui-js) over the Three.js canvas.

## Stack

- React + Vite
- Three.js
- imgui-js (from `flyover/imgui-js`)
- dff-loader

## Run

```bash
npm install
npm run dev
```

Open the app, then:

1. Click **Pick extracted GTA folder**.
2. Select your extracted game data directory (must include `data/gta.dat`, IDE/IPL text files, and extracted `.dff` / `.txd` files).
3. Click **Build World** (or use ImGui panel button).

## Supported parsing right now

- `gta.dat`: reads `IDE` and `IPL` entries.
- `IDE`: reads `objs` and `tobjs` sections (`id`, `model`, `txd`).
- `IPL`: reads `inst` entries (model placement + quaternion).

## Notes / current limits

- Browser sandbox means game archives (`.img`) are not read directly; files must be extracted first.
- Missing DFF/TXD or IDE entries are skipped and counted in the UI.
- Placement cap is configurable in ImGui to keep load times manageable.
- Current prototype does not yet include streaming sectors, LOD switching, occlusion/culling, COL collisions, or 2DFX.
