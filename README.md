# InkVault

Obsidian-style Markdown notes, with one change: **you type on the PC and draw on the tablet.**

- **PC** (`/pc`): file tree, Markdown editor, `[[wikilinks]]`, search, quick switcher, reading view.
  Drawing fields appear inline and update live, but you can't draw on the PC.
- **Tablet** (`/tablet`): blank until the PC opens a drawing field, then it switches to that field
  automatically. It's pen-only (palm rejection), with pressure and tilt, pen / pencil / highlighter,
  colors, scribble-to-erase, an eraser, and undo/redo.

Notes are plain `.md` files and drawings are `.svg` files, so the vault also opens in Obsidian.

## Run it on CasaOS (or any Docker host)

Every push to `main` makes GitHub Actions build the image and publish it as
`ghcr.io/<your-user>/inkvault:latest` (amd64 + arm64).

1. If you fork this, replace `daviied` in `docker-compose.yml` with your GitHub username in lowercase
   (it appears in the image name, the author fields and the icon URL).
2. Push the repo to GitHub, then open the **Actions** tab and wait for "Docker image" to finish (~5 min).
3. Make the image public: on your GitHub profile → **Packages** → `inkvault` → **Package settings** →
   **Change visibility** → Public. (New packages start private, even from a public repo.)
4. In CasaOS: **App Store** → **+** (top right) → **Install a customized app** → **Import** →
   paste `docker-compose.yml` → **Install**.
5. Open `http://<casaos-ip>:4777/pc` on the PC. Click the tablet status in the bottom bar for the tablet
   address and a QR code.

Notes are stored on the server in `/DATA/AppData/inkvault/vault`.
**Updating:** push to GitHub, wait for the build, then in CasaOS open the app's settings and pull the
latest image (or run `docker compose pull && docker compose up -d`).

To build from source instead of pulling: `docker compose -f docker-compose.build.yml up -d --build`.

## Run it without Docker

Requires Node 20+.

```bash
npm install
npm run build
npm start
```

`npm run dev` rebuilds the web clients when files change. `VAULT_DIR` and `PORT` env vars override the defaults.

## Using it

| PC | |
|---|---|
| Insert drawing | `Ctrl+Alt+D` or the toolbar button. Adds a field and opens it on the tablet |
| Send an existing drawing to the tablet | click it |
| Release the tablet | **Done drawing** / `Esc` |
| Quick switcher | `Ctrl+O` |
| Reading view | `Ctrl+E` |
| Search | `Ctrl+Shift+F` |
| New note | `Alt+N` |
| Follow a link | click a `[[link]]` (Ctrl+click: new tab) |
| Math | `Ctrl+M` (inline) / `Ctrl+Shift+M` or **Math** button (block) opens a Desmos-style math box: `^` exponent, `/` fraction, `sqrt`, `pi`, `theta`, `<=` … convert as you type. Enter/Tab/Esc finishes. Click an equation to edit it, Alt+click for raw LaTeX. Stored as LaTeX (`$…$`, `$$…$$`), so Obsidian renders it too |

| Tablet | |
|---|---|
| Draw / write | pen only. Fingers and palms never draw |
| Pan / zoom | two fingers |
| Undo / redo | the buttons in the toolbar |
| Erase | scribble over ink, use the eraser tool, or the pen's eraser end / side button |
| Shading | tilt the pen with the pencil tool. Tilting also widens the highlighter |
| More space | the page grows as you write near the bottom, or ⋯ → Add space below |

## Installing the tablet app

Open `http://<server>:4777/install` on the tablet and follow the three steps (one-time).

Why: browsers only give a page the pen's full sample rate (~240/s instead of ~60/s, so fast
handwriting stays smooth) and only let it be installed as a fullscreen app over **https**. The server
serves https on port **4778** with a certificate from its own small certificate authority, created on
first start and kept in `<vault>/.inkvault/tls`. The tablet installs that authority's certificate
once (`/ca.crt`). The server certificate automatically covers every address the server is reached by,
so changing IPs or using `casaos.local` needs no reinstall. Set `HTTPS_PORT=0` to turn https off.

Without the setup, the tablet page still goes fullscreen on the first tap (toggle in the ⋯ menu),
and on iPad, Share → **Add to Home Screen** works over plain http.

## Layout

```
server/     headless REST + WebSocket API (the only thing in the Docker image besides static files)
shared/     ink.js: stroke geometry, rendering, SVG format, eraser and scribble detection
web/pc/     PC client (CodeMirror 6)
web/tablet/ tablet client (Pointer Events)
public/     HTML/CSS/manifest/service worker; web bundles are built into public/build
docs/       PROTOCOL.md: the API that future native clients will use
```

## Roadmap: native apps

The server is already client-agnostic. Everything goes through [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

- **Android app**: native pen input (`MotionEvent` pressure, tilt and `TOOL_TYPE_STYLUS` for palm
  rejection), lower latency with the front-buffered rendering in `androidx.graphics:graphics-core`.
  Port `radiusAt` / `alphaAt` / `shapes` from `shared/ink.js` so the ink looks identical.
- **Windows app**: the quickest route is wrapping the existing PC client in Tauri or Electron and
  pointing it at the server. A fully native app (WinUI) would use the same REST + WS API.
