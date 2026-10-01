# InkVault protocol (v1)

The server is headless: everything a client can do goes through this REST + WebSocket API.
The web PC and tablet clients are just the first two clients; a native Android app or
Windows app can be built against the same API without any server changes.

Base URL: `http://<host>:4777` (or whatever `PUBLIC_URL` points to).

## Data model

### Notes
Plain Markdown files inside the vault folder (`/vault` in Docker). Paths are vault-relative,
use `/`, and end in `.md`. A drawing is embedded in a note as its own line:

```
![[ink-<drawingId>.svg]]
```

This is Obsidian's embed syntax, so the same vault opens in Obsidian and shows the drawings.

### Drawings
Stored as `Drawings/ink-<id>.svg`. Each file is a normal SVG image that also embeds the
source data in `<metadata id="inkvault-data">` (XML-escaped JSON):

```jsonc
{
  "v": 1,
  "id": "mupxzgbw01pv1w",       // [a-z0-9]{4,40}
  "width": 1000,                // always 1000 logical units
  "height": 560,                // grows downward as you write
  "strokes": [{
    "id": "mupy087c016qss",
    "z": 1790883853000123,      // paint order (ascending)
    "tool": "pen",              // "pen" | "pencil" | "highlighter"
    "color": "#1f1f1f",
    "size": 3,                  // nominal diameter in logical units
    "pts": [[x, y, pressure, tilt], ...]   // pressure 0..1, tilt 0 (upright)..1 (flat)
  }]
}
```

How a stroke looks (width and opacity from pressure and tilt) is defined in
[`shared/ink.js`](../shared/ink.js) (`radiusAt`, `alphaAt`, `shapes`). A native client should
port those three functions so that ink renders the same on every device. Highlighter strokes
are painted beneath all other strokes.

### Changes
A drawing is only ever mutated by a **change**:

```jsonc
{ "remove": ["strokeId", ...], "add": [stroke, ...], "height": 960 }   // every field optional
```

Apply `remove`, then `add` (a stroke whose id already exists is replaced), then `height`.
Erasing part of a stroke = remove it and add the remaining pieces under new ids.

## REST

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/info` | | `{ name, protocol, urls[], inDocker }` |
| GET | `/api/tree` | | nested `[{type:'folder',name,path,children}|{type:'file',name,path}]` |
| GET | `/api/notes` | | `["path.md", ...]` |
| GET | `/api/note?path=` | | `{ path, text }` |
| PUT | `/api/note?path=` | raw text | `{ ok }` (creates folders as needed) |
| POST | `/api/note` | `{ folder, name }` | `{ path }` (unique name) |
| DELETE | `/api/note?path=` | | `{ ok }` — moves the file or folder to `.trash/` |
| POST | `/api/rename` | `{ from, to }` | `{ path }` — files or folders |
| POST | `/api/folder` | `{ path }` | `{ path }` |
| GET | `/api/search?q=` | | `[{ path, hits: [{ line, text }] }]` |
| POST | `/api/drawing` | | new empty drawing |
| GET | `/api/drawing/:id` | | drawing |
| GET | `/api/qr?text=` | | SVG QR code |

Errors return a non-2xx status with `{ error }`.

## WebSocket `/ws`

JSON messages in both directions. Open the socket, then send `hello` first.

### Client → server

| type | fields | meaning |
|---|---|---|
| `hello` | `role: 'pc'|'tablet'`, `pending?: [{id, change}]` | identify; `pending` = changes made while offline |
| `open` | `id`, `note` | (PC) put this drawing on the tablet(s) |
| `close` | `id?` | release the tablet (ignored if `id` isn't the active one) |
| `change` | `id`, `change` | apply a change to a drawing |
| `live` | `id`, `sid`, `stroke|null` | in-progress stroke preview (not saved); `null` cancels |

### Server → client

| type | fields | sent to |
|---|---|---|
| `state` | `active: {id, note}|null`, `tablets`, `pcs` | everyone, whenever it changes |
| `open` | `id`, `note`, `drawing` | tablets (also right after a tablet's `hello` if a drawing is active) |
| `close` | | tablets |
| `change` | `id`, `change` | everyone except the sender |
| `live` | `id`, `sid`, `stroke|null` | everyone except the sender |
| `tree` | | everyone, when files were created, renamed or deleted |

### Expected behavior of a tablet client
1. Show nothing while no drawing is active.
2. On `open`, show the drawing full-screen, ready for the pen.
3. Apply your own changes locally, send them as `change`, and keep your own undo stack
   (undo = send the inverse change).
4. Stream the stroke being drawn as `live` roughly every 40 ms, so the PC sees it as it's drawn.
5. Queue changes while offline and send them in the next `hello`.

### Expected behavior of a PC client
Render drawings read-only, apply incoming `change` and `live` messages, and send `open` /
`close` to direct the tablet.
