"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type EditorHandle } from "./Editor";

interface NoteMeta {
  id: string;
  path: string;
  sha?: string;
}

type SaveState = "idle" | "saving" | "saved" | "error";

// Turn a file id into a friendly display name.
// New format: YYYYMMDDHHmm + weekday, e.g. 202606301010Tue -> 20260630 10:10 Tue
// Falls back to the raw id for legacy or unrecognized names.
function formatNoteName(id: string): string {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})([A-Za-z]{3})$/);
  if (m) {
    const [, y, mo, d, h, mi, week] = m;
    return `${y}${mo}${d} ${h}:${mi} ${week}`;
  }
  return id;
}

export default function Home() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [sha, setSha] = useState<string | undefined>(undefined);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Multi-select mode
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  // Mobile: the sidebar becomes a slide-in drawer, toggled by a hamburger.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  // Lock body scroll while the mobile drawer is open, and close it on Escape.
  useEffect(() => {
    if (!sidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [sidebarOpen]);

  // Manual-save button feedback: spinner while saving, a brief flash on success.
  const [manualSaving, setManualSaving] = useState(false);
  const [manualDone, setManualDone] = useState(false);
  const manualDoneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  // Refs let callbacks (upload, debounced save) read the latest values
  // without capturing stale closures.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const shaRef = useRef<string | undefined>(undefined);
  shaRef.current = sha;
  const contentRef = useRef<string>("");
  contentRef.current = content;

  // Load the note list
  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/notes");
      const data = await res.json();
      if (data.notes) setNotes(data.notes);
    } catch {
      // Network hiccup: keep the current list rather than clearing it.
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Open a note
  const openNote = useCallback(async (id: string) => {
    setLoading(true);
    setActiveId(id);
    setSidebarOpen(false); // close the mobile drawer once a note is chosen
    try {
      const res = await fetch(`/api/notes/${id}`);
      const data = await res.json();
      setContent(data.content ?? "");
      setSha(data.sha);
      setSaveState("idle");
    } finally {
      setLoading(false);
    }
  }, []);

  // Create a note
  const createNote = useCallback(async () => {
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    const data = await res.json();
    if (data.id) {
      await loadList();
      setActiveId(data.id);
      setContent("");
      setSha(data.sha);
      setSaveState("saved");
      setSidebarOpen(false); // close the mobile drawer after creating
    }
  }, [loadList]);

  // Save (called after debounce for auto-save, or immediately for manual save)
  const save = useCallback(
    async (
      id: string,
      text: string,
      curSha?: string,
      mode: "auto" | "manual" = "auto"
    ) => {
      setSaveState("saving");
      try {
        const res = await fetch(`/api/notes/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text, sha: curSha, mode }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Save failed");
        setSha(data.sha);
        setSaveState("saved");
        // Update the sha for this item in the list
        setNotes((prev) =>
          prev.map((n) => (n.id === id ? { ...n, sha: data.sha } : n))
        );
        return true;
      } catch {
        setSaveState("error");
        return false;
      }
    },
    []
  );

  // Content change -> debounced auto-save
  const onEditorChange = useCallback(
    (text: string) => {
      setContent(text);
      if (!activeId) return;
      setSaveState("saving");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        // shaRef always holds the latest sha, avoiding a stale closure.
        void save(activeId, text, shaRef.current);
      }, 1000);
    },
    [activeId, save]
  );

  // Manual save: cancels any pending auto-save, saves immediately, and shows
  // a spinner while in flight then a brief success flash.
  const saveNow = useCallback(async () => {
    if (!activeId || manualSaving) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (manualDoneTimer.current) clearTimeout(manualDoneTimer.current);
    setManualDone(false);
    setManualSaving(true);
    const ok = await save(activeId, contentRef.current, shaRef.current, "manual");
    setManualSaving(false);
    if (ok) {
      setManualDone(true);
      manualDoneTimer.current = setTimeout(() => setManualDone(false), 1800);
    }
  }, [activeId, manualSaving, save]);

  // Upload an image and return an accessible URL (for the editor to insert)
  const uploadImage = useCallback(
    async (file: File): Promise<string | null> => {
      const noteId = activeIdRef.current;
      if (!noteId) {
        alert("Select a note before inserting an image");
        return null;
      }
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("noteId", noteId);
        const res = await fetch("/api/upload", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        return data.url as string;
      } catch (e: any) {
        alert("Image upload failed: " + e.message);
        return null;
      } finally {
        setUploading(false);
      }
    },
    []
  );

  // Pick a file from the toolbar
  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void editorRef.current?.insertImageFromFile(file);
      e.target.value = "";
    },
    []
  );

  // Delete the current note (remove from list, files kept)
  const removeCurrent = useCallback(async () => {
    if (!activeId) return;
    if (!confirm("Delete this note?")) return;
    await fetch(`/api/notes/${activeId}`, { method: "DELETE" });
    setActiveId(null);
    setContent("");
    setSha(undefined);
    await loadList();
  }, [activeId, loadList]);

  // Toggle multi-select mode
  const toggleSelectMode = useCallback(() => {
    setSelectMode((v) => !v);
    setSelected(new Set());
  }, []);

  // Toggle selection of one item
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Select all / deselect all
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === notes.length) return new Set();
      return new Set(notes.map((n) => n.id));
    });
  }, [notes]);

  // Delete selected items (remove from list, files kept)
  const removeSelected = useCallback(async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected note(s)?`)) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.failed
          ? data.failed.map((f: any) => `${f.id}: ${f.error}`).join("\n")
          : data.error || "Delete failed";
        alert("Some or all deletions failed:\n" + msg);
      }
      // If the open note was deleted, clear the editor
      if (activeId && ids.includes(activeId)) {
        setActiveId(null);
        setContent("");
        setSha(undefined);
      }
      setSelected(new Set());
      setSelectMode(false);
      await loadList();
    } finally {
      setDeleting(false);
    }
  }, [selected, activeId, loadList]);

  const statusText: Record<SaveState, string> = {
    idle: "",
    saving: "Saving…",
    saved: "Saved",
    error: "Save failed, retrying…",
  };

  return (
    <div className={"layout" + (sidebarOpen ? " sidebar-open" : "")}>
      {/* Mobile-only scrim behind the drawer */}
      <div
        className="sidebar-scrim"
        onClick={closeSidebar}
        aria-hidden={!sidebarOpen}
      />
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">Open Notes</span>
          {!selectMode ? (
            <div className="header-actions">
              <button className="btn" onClick={toggleSelectMode}>
                Select
              </button>
              <button className="btn btn-primary" onClick={createNote}>
                New Note
              </button>
              <button
                className="btn btn-icon sidebar-close"
                onClick={closeSidebar}
                aria-label="Close menu"
              >
                ✕
              </button>
            </div>
          ) : (
            <button className="btn" onClick={toggleSelectMode}>
              Cancel
            </button>
          )}
        </div>

        {selectMode && (
          <div className="select-bar">
            <label className="select-all">
              <input
                type="checkbox"
                checked={notes.length > 0 && selected.size === notes.length}
                ref={(el) => {
                  if (el)
                    el.indeterminate =
                      selected.size > 0 && selected.size < notes.length;
                }}
                onChange={toggleSelectAll}
              />
              All
            </label>
            <span className="select-count">{selected.size} selected</span>
            <button
              className="btn btn-danger"
              onClick={removeSelected}
              disabled={selected.size === 0 || deleting}
            >
              {deleting ? "Deleting…" : "Delete selected"}
            </button>
          </div>
        )}

        <div className="note-list">
          {notes.length === 0 && (
            <div className="note-list-empty">
              No notes yet.
              <br />
              Click “New” to start.
            </div>
          )}
          {notes.map((n) => (
            <div
              key={n.id}
              className={
                "note-item" +
                (n.id === activeId && !selectMode ? " active" : "") +
                (selectMode && selected.has(n.id) ? " checked" : "")
              }
              onClick={() =>
                selectMode ? toggleSelect(n.id) : openNote(n.id)
              }
            >
              {selectMode && (
                <input
                  type="checkbox"
                  checked={selected.has(n.id)}
                  readOnly
                  className="note-check"
                />
              )}
              <div className="title">{formatNoteName(n.id)}</div>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {activeId && !selectMode ? (
          <>
            <div className="toolbar">
              <button
                className="btn btn-icon menu-toggle"
                onClick={toggleSidebar}
                aria-label="Open menu"
              >
                ☰
              </button>
              <label className="btn">
                {uploading ? "Uploading…" : "Insert Image"}
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={onPickFile}
                  disabled={uploading}
                />
              </label>
              <span className="hint">or paste / drop an image anywhere</span>
              <button
                className={
                  "btn btn-save" +
                  (manualSaving ? " is-saving" : "") +
                  (manualDone ? " is-done" : "")
                }
                onClick={saveNow}
                disabled={manualSaving}
              >
                {manualSaving ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    Saving…
                  </>
                ) : manualDone ? (
                  <>
                    <span className="check" aria-hidden="true" />
                    Saved
                  </>
                ) : (
                  "Save"
                )}
              </button>
              <button className="btn btn-danger" onClick={removeCurrent}>
                Delete
              </button>
              <span className={"status " + saveState}>
                {statusText[saveState]}
              </span>
            </div>
            {loading ? (
              <div className="empty">Loading…</div>
            ) : (
              <Editor
                ref={editorRef}
                value={content}
                noteId={activeId}
                onChange={onEditorChange}
                uploadImage={uploadImage}
              />
            )}
          </>
        ) : (
          <>
            <div className="toolbar toolbar-empty">
              <button
                className="btn btn-icon menu-toggle"
                onClick={toggleSidebar}
                aria-label="Open menu"
              >
                ☰
              </button>
              <span className="toolbar-brand">Open Notes</span>
            </div>
            <div className="empty">
              {selectMode
                ? "Select mode: check notes on the left, then click “Delete selected”."
                : "Select a note on the left, or click “New Note” to start."}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
