# Open Notes

**Dead-simple web notes. Your repo is the database.**

Write text, drop in images, and everything auto-saves. Open the URL, jot something down, close the tab — no accounts, no
setup, no database to run. Every note is just Markdown committed straight into a GitHub repository.

## Why Open Notes

- **Simple** — one screen: a list on the left, an editor on the right. That's it.
- **Zero-setup** — deploy once, add a single token, start writing.
- **Repo *is* the database** — notes and images live as plain files in a GitHub repo. Nothing else to host, back up, or
  pay for.
- **Come and go** — no login, no session. Open, type, leave. It's saved.

## Features

- Multiple notes managed from a left-hand list
- WYSIWYG editor that stores content as clean Markdown
- Auto-save while you type (1s debounce) with a live status indicator
- Paste, drag-and-drop, or pick images to upload
- Multi-select with "select all" for bulk deletion
- Deleting a note just hides it from the list — the files stay in your repo

## Repo = Database

Every note is a self-contained folder committed to your GitHub repo:

```
notes/
  202607011142Wed/
    202607011142Wed.md      # the note (Markdown)
    attachment/             # images for this note
      img-....png
    .hidden                 # present when the note is "deleted" (hidden from the list)
```

Your notes are always readable, portable, and version-controlled — just files in a repo. No lock-in.

### Notes live on a dedicated branch

When using the GitHub backend, notes are committed to a **separate data branch**
(default `notes-data`), *not* the branch you deploy code from (`main`/`master`).
The app creates that branch automatically on the first save, branching off your
code branch.

Why this matters: if your repo is a **fork** that syncs code from an upstream
using a force-push workflow (e.g. `github-forks-sync-action` with `force: true`),
that sync only overwrites the **code branch**. Your notes on `notes-data` are
never touched, so **syncing upstream code can't wipe your notes**.

- Keep the data branch **out of any fork-sync matrix** (only sync `main`/`master`).
- Override the branch name with `GITHUB_DATA_BRANCH` if you like.

## Get started

### Run locally

No configuration required — notes are saved to the local `data/` folder.

```bash
npm install
npm run dev
```

Open http://localhost:3000 and start writing. Notes land in `data/notes/<id>/`, with images under each note's
`attachment/` folder.

### Deploy

You only need **one** thing: a GitHub token so the app can write notes into your repo.

1. Deploy the app (any host that runs Next.js works).
2. Create a GitHub fine-grained token with **Contents: Read and write** on the repo you want to store notes in.
3. Set it as the `GITHUB_TOKEN` environment variable.
4. Open the URL and start writing. The first save creates the `notes-data`
   branch (and the `notes/` folder on it) automatically.

## License

[MIT](./LICENSE) © OrekiYuta
