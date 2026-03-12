# GTA Map Renderer (React + Vite + Three.js)

Browser-based GTA map renderer that parses `gta.dat`, loads referenced `IDE` + `IPL`, and renders placed world objects by loading matching `.dff` + `.txd` using [`dff-loader`](https://github.com/Jackal1337/DFF-Loader).

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

## Rendering features

- World placement rendering from extracted GTA data.
- Timecycle-driven scene colors and fog.
- Distance/LOD transitions with fade proxies.
- RW material descriptor pipeline for default world rendering.
- Custom RW pipeline debug profiles in `Rendering > Pipeline`.

## Custom RW pipeline

The renderer now includes a profile-driven RW pipeline layer for debugging and visual comparison.

- Profiles are switched live from ImGui without rebuilding the world.
- Selection is grouped by `Game -> Category -> Platform`.
- Default debug selection is:
  - `Game = DEFAULT (auto-resolves from current map)`
  - `Category = building`
  - `Platform = PS2`
- Current implemented custom profiles:
  - `Leeds / VCS / Building / PS2`
  - `Leeds / VCS / Building / PSP`
- Current non-implemented combinations are left as interface/registry slots for future expansion.

Current Leeds implementation notes:

- Building color logic follows a Leeds-style profile path.
- Fog is intentionally delegated to the default Three.js material fog path.
- Shader/profile code is organized under `src/lib/rwPipelineProfiles.js` and `src/shaders/building/leeds/vcs/`.
- Pipeline switching is runtime-managed through `RWPipelineController`.

## Supported parsing right now

- `gta.dat`: reads `IDE` and `IPL` entries.
- `IDE`: reads `objs` and `tobjs` sections (`id`, `model`, `txd`).
- `IPL`: reads `inst` entries (model placement + quaternion).

## Notes / current limits

- Browser sandbox means game archives (`.img`) are not read directly; files must be extracted first.
- Missing DFF/TXD or IDE entries are skipped and counted in the UI.
- Placement cap is configurable in ImGui to keep load times manageable.
- Custom RW pipeline support is currently focused on `VCS building PS2/PSP`.
- Other games/platforms such as `SA`, `PC`, and additional Leeds/RW pipelines are not implemented yet.
- Custom pipeline performance is still under active optimization; a shared material cache is in place, but dense scenes may still cost more than the default material path.
- The project still does not fully cover occlusion/culling, COL collisions, or full 2DFX behavior.
