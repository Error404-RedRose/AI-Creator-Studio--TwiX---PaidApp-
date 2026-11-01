# AI Creator Studio Bridge (Unity Editor package)

This is a **local Unity Package Manager (UPM) package** that lets
**AI Creator Studio by Twilight Studio** discover and work with an open Unity
project. It is an Editor-only package and does not add runtime components to
your game.

The package starts a small loopback HTTP bridge on `127.0.0.1` (ports
`47823`–`47843`). The desktop app detects the bridge, shows the Unity project
and scene, displays the scene hierarchy, focuses objects, refreshes assets,
requests script compilation, and enters/exits play mode.

## Install in Unity

1. Open your Unity project.
2. Open **Window → Package Manager**.
3. Click the **+** button → **Add package from disk…**.
4. Select `package.json` inside this folder
   (`unity/com.twilightstudio.creatorstudio/package.json`).
5. Unity compiles the Editor assembly and the bridge starts automatically.

You can also copy the folder into your project's `Packages/` directory.

## Menu

- **AI Creator Studio → Unity Bridge → Start**
- **AI Creator Studio → Unity Bridge → Stop**
- **AI Creator Studio → Unity Bridge → Auto-start on Load**

The bridge only listens on the local loopback interface. It does not expose
the Unity project to the network. Commands are limited to editor actions listed
below.

## Endpoints

- `GET /ping` — project root, project name, Unity version, scene, bridge port.
- `GET /state` — project/scene state, compile messages, and the active scene
  hierarchy with component names.
- `POST /command` — JSON `{ "action": "...", "path": "..." }`.

Supported actions include `refresh`, `compile`, `clear_compile_messages`,
`play`, `stop`, `focus`, `get_object`, `find_objects`, `find_assets`,
`create_object`, `create_empty`, `delete_object`, `duplicate_object`,
`move_object`, `rotate_object`, `scale_object`, `set_transform`,
`rename_object`, `set_parent`, `set_active`, `set_tag_layer`,
`add_component`, `remove_component`, `set_component_enabled`,
`set_property`, `set_material_property`, `apply_material`,
`create_material`, `set_setting`, `save_scene` and `open_scene`.

## Notes

- Compilation is requested through `CompilationPipeline.RequestScriptCompilation`.
  Unity may reload assemblies; the app reports that in its Unity console.
- The bridge is an editor integration. It is not a replacement for the Unity
  Editor and does not run in builds.
- If Windows blocks `HttpListener` for the loopback prefix, run Unity once as
  administrator or choose a different port range. No admin rights are normally
  required for `127.0.0.1`.
