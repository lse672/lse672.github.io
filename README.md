# Upcoming Expenses: a Standard Notes plugin

This plugin lets you plan one-off and recurring expenses (weekly, monthly, yearly), see what's due month by month with running totals, and tick payments off as you make them. All data lives in the note's text as JSON, so it is end-to-end encrypted and synced like any other note.

## Try it locally

No build step is needed. From this folder, run:

```bash
python3 -m http.server 8001
```

- **Preview in a browser:** open http://localhost:8001/index.html. Outside Standard Notes it loads sample data and saves nothing.
- **Install in Standard Notes:** go to Preferences → Plugins → "Install custom plugin" and paste `http://localhost:8001/ext.json`. Then create a new note and pick **Upcoming Expenses** as its editor.

## Host it for real

1. Put the folder on any static host (GitHub Pages works fine).
2. Change `url` in `ext.json` to the hosted `index.html`, and give `identifier` your own reverse-domain name.
3. Install the plugin from the hosted `ext.json` URL.
4. Optionally, for the desktop app to work offline, add a `download_url` pointing to a zip of the folder.

`component-relay.js` is the official `@standardnotes/component-relay` 2.2.2 browser build, included so the plugin has no outside dependencies. Its license (AGPL-3.0) is in `component-relay.LICENSE`.

## Safety

- If you open the editor on a note that already contains non-JSON text, the plugin won't touch the note until you click "Replace with empty list".
- Locked notes are shown read-only.

## Ideas to extend

- Add a monthly budget line and warn when a month goes over it.
- Track per-occurrence amount overrides, for bills that vary.
- Export a month to CSV.
- Add a "skip this occurrence" option alongside paid.
