# deps-graph

A single-page dependency graph visualizer built with [Cytoscape.js](https://js.cytoscape.org/), [Alpine.js](https://alpinejs.dev/) and [Tailwind CSS v4](https://tailwindcss.com/).

Define dependencies in a simple text format, tweak colors and layout, run set queries — all in the browser. Every setting is persisted in the URL so graphs can be shared as links.

## Syntax

```
"Source"-Label->"Target" key=value another="quoted value"
```

Lines starting with `#` or `//` are comments.

### Example

```
Auth-Login->API
API-Query->Database
API-Cache->Redis priority=high
Redis-Sync->Database status=active
Frontend-Request->API
Frontend-Assets->CDN
```

## Features

- **Edge attributes** — attach `key=value` pairs (including quoted values) to any edge.
- **Edge color rules** — color edges dynamically based on attribute values (`is` / `contains`).
- **Analysis tab** — upstream/downstream queries, roots & leaves detection, edge path queries between any two nodes with full attribute display and hover/click highlighting.
- **Theming** — main, accent and edge colors; node size & shape; curve offset; hub spread.
- **Shareable URLs** — all settings (config, colors, layout, rules, active tab) serialize into query params.
- **Export** — PNG, JPG or SVG download.
- **Fullscreen** — view the graph without the side panel.
- **Resizable aside** — drag the handle or collapse/expand with a button.

## Getting started

```bash
make install   # npm install
make dev       # tailwind --watch + live-server on localhost:3000
```

## Build

```bash
make build     # optimized dist/ (minified CSS + JS + HTML)
make serve     # serve dist/ locally
```

## Release & deploy

Releases are published to GitHub Pages via a GitHub Actions workflow triggered on release creation.

```bash
make release name=v1.0   # pushes, tags, creates GH release, triggers deploy
```

Version format: `vX.Y`.

## Stack

| Layer   | Tool              |
|---------|-------------------|
| Graph   | Cytoscape.js 3.26 |
| UI      | Alpine.js 3       |
| CSS     | Tailwind CSS v4   |
| Bundle  | esbuild           |
| Dev     | live-server        |

## License

MIT
