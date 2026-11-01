# AI Creator Studio

**By Twilight Studio** · Version **0.6.0-alpha.1** · Windows x64

A native Windows creative workspace where AI agents and manual tools share the same project.
Model in 3D, simulate cloth, format writing, code with an AI agent, drive a live Unity Editor,
edit layered images, and run AI research — all from one desktop application.

---

## What's in this folder

| Item | Description |
| --- | --- |
| `AI Creator Studio by Twilight Studio.exe` | The application. Run it from this folder. |
| `resources/`, `locales/`, `*.dll`, `*.pak`, `*.bin` | Required runtime files. Do not move or delete them. |
| `README.md` | This document. |
| `LICENSE.txt` | License terms for AI Creator Studio. |
| `LICENSE.electron.txt`, `LICENSES.chromium.html` | Third-party license notices. |

Keep this folder intact. The executable depends on the DLLs, `resources.pak`, `locales/`, and the
other bundled files beside it — the app will not start if files are separated or moved out.

> This is alpha software. Back up important projects and expect interface changes between builds.

---

## System requirements

- **Windows 10 or Windows 11, 64-bit**
- **8 GB RAM recommended** (4 GB minimum)
- A GPU and driver with **WebGL 2** support
- **About 1 GB free disk space** for the application, plus room for projects
- **Internet connection** for product activation, AI providers, GitHub, and updates
- **OpenCode CLI** installed on the same PC to use AI features (see below)

The app is Windows-first. Other platforms are not packaged or supported.

---

## Run the app

1. Open `AI Creator Studio by Twilight Studio.exe` in this folder.
2. If Windows SmartScreen appears, choose **More info → Run anyway**. The build is not
   code-signed.
3. Enter your product key when the activation screen appears.

The application opens as a full-screen, frameless window with a custom title bar. Use the title
bar buttons for Home, minimize, and close.

To move the app to another location, copy the **entire folder**, not just the executable.

---

## Activation

AI Creator Studio requires a **product key**.

- Enter the key on the activation screen or in **Settings → License**.
- An internet connection is required to verify the key. The app re-checks it while running.
- A valid key stays unlocked. An expired, revoked, or device-mismatched key returns to the
  activation screen.
- Each key is tied to the device it was first activated on.

Need a key or hit an activation problem? Contact Twilight Studio using the details at the bottom
of this file.

---

## Set up AI (OpenCode)

AI features run through the local **OpenCode CLI**, which must be installed on this PC.

1. Install OpenCode and make sure the `opencode` command is available on your `PATH`.
2. Open AI Creator Studio and go to **Settings → OpenCode**.
3. If OpenCode is not found automatically, browse to the executable path.
4. Open a project and choose a model from the top bar.

**Each workspace remembers its own model.** The model you select for Writing is used for Writing;
the model you select for Coding is used for Coding, and so on. Choose models with tool calling
support for 3D scene editing, coding, and GitHub actions.

You can also configure provider API keys for OpenAI and Gemini in **Settings → Providers** if you
want those providers in Research or Photo.

---

## Workspaces

### 3D Studio
Real-time modeling with object and mesh modes, move/rotate/scale gizmos, rectangle and pen tools,
vertex editing, measurement, decimation, smooth/flat shading, and scene presets. Import FBX, GLB,
GLTF, and OBJ; export GLB, OBJ, STL, and FBX. Materials include full PBR maps, procedural
patterns, a Material Lab, UV generation, and a stretch-colored UV viewer. Rigging, blend shapes,
lighting, cameras, and six viewport modes are included.

### Clothworks
A real-time cloth simulator with Curtain, Blanket, Towel, and Pillow presets. Adjust gravity,
wind, stiffness, and damping; switch between sphere and box colliders; toggle wireframe; pause,
play, or reset the simulation.

### Writing
Paste raw text and press **Format** (or `Ctrl`+`Enter`). The app starts a fresh AI session, shows
live progress and elapsed time, and returns clean professional text. **Copy** places rich HTML and
plain text on the clipboard so headings, lists, bold, and links survive when pasted into email or
a document. **Cancel** stops a slow run immediately.

### Coding
A file tree, tabbed editor, dirty-state tracking, search, image attachments, and persistent
sessions. The AI view streams file edits with added/removed line highlights, command output, and
up to four concurrent agent panels. **Follow AI edits** jumps to each completed write. Writes and
commands stay disabled until you explicitly trust the project.

### Unity Live
Connect to an open Unity Editor project. The app shows the project, active scene, and a filterable
hierarchy; focuses objects on double-click; surfaces compile and scene messages; and can refresh
assets, request script compilation, and enter or exit play mode. Install the bundled bridge from
`resources\app\unity\com.twilightstudio.creatorstudio` using **Package Manager → + → Add package
from disk…** (Unity 2021.3 or newer). The bridge listens on loopback only.

### Photo
Layered canvas editing with brush, eraser, rectangle, ellipse, and text. Add, duplicate, reorder,
hide, and blend layers. Import images, save layered `.creatorstudio.json` documents, and export
flattened PNG, JPEG, or WebP. AI output arrives as a new SVG layer instead of replacing the canvas.

### Research
Chat with OpenCode, OpenAI, or Gemini. Search the web through DuckDuckGo, add results to project
references in one click, and optionally include GitHub repository and code matches as research
context for every prompt.

---

## GitHub (optional)

Connect a **fine-grained personal access token** in **Settings → GitHub**.

- The token is stored locally and redacted from logs.
- Browse repositories, branches, and file trees; read files; search code and repositories.
- Create repositories, commit and push text files, and open issues or pull requests.
- Add search matches to the reference library.

Enable **Search GitHub with every prompt** to give the AI related public repositories and code as
context. Binary assets and very large batches should be downloaded rather than pushed; keep
individual pushed files under 25 MB and batches under 50 MB.

---

## Your data

| Data | Location |
| --- | --- |
| Settings, logs, mods, references | `Documents\3D Creator Studio` |
| Projects | `E:\CREATOR STUDIO` when drive `E:` exists, otherwise `Documents\3D Creator Studio Projects` |

The project folder is configurable in Settings. Open **Settings → Diagnostics** to browse logs,
open the exact log folder, or download the current log. Logs are JSONL and have API keys and
tokens redacted.

Back up `Documents\3D Creator Studio` if you want to keep your settings, references, and learning
notes. Projects should be backed up separately.

---

## Troubleshooting

**The app does not open**
- Confirm the executable is still inside this folder with its DLLs, `resources`, and `locales`.
- Re-extract or re-copy the complete build if files were moved or deleted.
- Check **Settings → Diagnostics** after a successful launch, or open the log folder shown there.

**Windows SmartScreen warning**
- Choose **More info → Run anyway**. The build is not code-signed.

**Blank or black window**
- Update your graphics driver.
- Close other GPU-heavy applications.
- If the problem persists, report it with the log file attached.

**AI is offline or no models appear**
- Confirm OpenCode is installed and `opencode` runs in a terminal.
- Check the executable path in **Settings → OpenCode**.
- Use **Test connection** and review the activity console for the exact error.

**AI requests time out**
- Choose a faster model for that workspace. Model choice is saved per workspace.
- Some free or remote models are slow or queue heavily; try another provider.
- In Writing, press **Cancel** and retry with a different model.

**Unity project is not detected**
- Install the bridge package from `resources\app\unity\com.twilightstudio.creatorstudio`.
- Confirm the bridge is running in Unity under **AI Creator Studio → Unity Bridge**.
- Allow loopback traffic for `127.0.0.1` ports `47823–47843` in your firewall.
- Unity must be open with the project loaded; the bridge does not run in built players.

**Activation fails**
- Confirm the PC is online.
- Check the key for typos and confirm it has not expired or been activated on another device.
- Contact Twilight Studio if the key should be valid.

---

## Uninstall

1. Close AI Creator Studio.
2. Delete this application folder.
3. Optional: delete `Documents\3D Creator Studio` to remove settings, references, logs, and local
   AI history. This also removes your saved API keys and activation state.
4. Optional: delete the app's Electron data folder under `%APPDATA%` if you want no residual cache.

Back up projects before deleting any data folder.

---

## Third-party components

This application includes open-source and third-party components, including **Electron**,
**Chromium**, **Node.js**, **React**, **Three.js**, **Express**, and **Zustand**.

- Electron and Chromium license texts ship alongside the executable
  (`LICENSE.electron.txt` and `LICENSES.chromium.html`).
- Other components retain their own licenses and copyright notices.

Nothing in the AI Creator Studio license restricts rights granted to you by those component
licenses.

---

## License

AI Creator Studio is proprietary software by Twilight Studio. Use is governed by `LICENSE.txt` in
this folder. A valid product key is required to run the application.

---

## Support

**Twilight Studio**

- Discord: [discord.gg/V2vDQCUSNe](https://discord.gg/V2vDQCUSNe)
- Email: [twilightstudio.dev@gmail.com](mailto:twilightstudio.dev@gmail.com)
- Website: [twilightstudio.carrd.co](https://twilightstudio.carrd.co/)

When reporting a problem, include the app version, a short description, and the relevant log
lines from **Settings → Diagnostics**. Remove any personal information before sharing.

© 2026 Twilight Studio. All rights reserved.
