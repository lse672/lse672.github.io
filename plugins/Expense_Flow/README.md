# Expense Flow: a Standard Notes plugin

Track what comes in and what goes out, by category and sub-category, with recurring entries (weekly, monthly, yearly) and a Sankey diagram showing where the money goes: income → budget → categories → sub-categories. All data lives in the note's text as JSON, so it is end-to-end encrypted and synced like any other note.

## Try it locally

No build step is needed. From this folder, run:

```bash
python3 -m http.server 8002
```

- **Preview in a browser:** open http://localhost:8002/index.html. Outside Standard Notes it loads sample data and saves nothing.
- **Install in Standard Notes:** go to Preferences → Plugins → "Install custom plugin" and paste `http://localhost:8002/ext.json`. Then create a new note and pick **Expense Flow** as its editor.

## Host it for real

1. Create a GitHub repository named `Standard_Notes_Expense_Flow.github.io` and push this folder to it.
2. In the repository settings, turn on GitHub Pages for the `main` branch.
3. If you use another repository name, change `url` in `ext.json` to match.
4. Install the plugin from `https://lse672.github.io/Standard_Notes_Expense_Flow.github.io/ext.json`.

When you change the code, bump the version in three places at once: `"version"` in `ext.json`, `VERSION` in `app.js`, and every `?v=` in `index.html`. The `?v=` forces the apps (Android especially) to fetch the new files instead of a cached copy.

`component-relay.js` is the official `@standardnotes/component-relay` 2.3.2 browser build (from GitHub; the npm release is older and fails on Android), the same file as in Upcoming Expenses. Its license (AGPL-3.0) is in `component-relay.LICENSE`. The Sankey diagram is drawn by `app.js` itself, so the plugin loads nothing from the internet.

## How recurring entries work

A recurring series stores its rule (first date, frequency, optional end date), not its occurrences. Occurrences are computed up to today each time the note is shown, so opening the note on two devices never makes two competing saves. A date that doesn't exist in a month (the 31st, February 29th) falls on the month's last day.

- **Edit one occurrence:** tap it in the list. The change is stored for that date only.
- **Skip one occurrence:** open it and choose "Skip this occurrence".
- **Change the whole series:** tap it under "Recurring", or "Edit series" from one occurrence.
- **Stop a series:** "End series today" keeps the history; "Delete series" removes past occurrences too.

## Safety

- If you open the editor on a note that already contains other text, including an Upcoming Expenses list, the plugin won't touch the note until you click "Replace with empty ledger".
- If Standard Notes sends the note without its text while the preview shows it is an Expense Flow note, editing is turned off instead of saving an empty ledger over it.
- Locked notes are shown read-only.
- "Connection details" at the bottom shows what the plugin received, to help with debugging.

## Data format

```json
{
  "kind": "expense-flow", "version": 1, "currency": "EUR",
  "cats": [{ "id": "food", "name": "Food", "color": "#E0A526", "subs": [{ "id": "groceries", "name": "Groceries" }] }],
  "srcs": [{ "id": "salary", "name": "Salary", "color": "#3F9A5A" }],
  "tx":  [{ "id": "…", "type": "out", "amount": 12.5, "label": "Bread", "cat": "food", "sub": "groceries", "date": "2026-10-02", "note": "" }],
  "rec": [{ "id": "…", "type": "out", "amount": 700, "label": "Rent", "cat": "home", "sub": "rent", "note": "",
            "date": "2026-08-05", "repeat": "monthly", "until": null, "skip": [], "edits": {} }]
}
```

## References

- Schmidt, M. (2008). "The Sankey Diagram in Energy and Material Flow Management – Part I: History". *Journal of Industrial Ecology*, 12(1), 82–94. DOI: 10.1111/j.1530-9290.2008.00004.x
