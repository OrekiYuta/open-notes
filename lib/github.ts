// GitHub Contents API wrapper
// Docs: https://docs.github.com/en/rest/repos/contents
import type { Note, NoteMeta, NoteStore, SaveMode } from "./types";

const API = "https://api.github.com";

function cfg() {
  const token = process.env.GITHUB_TOKEN;
  // Repo resolution order:
  //   1. GITHUB_REPO (explicit override, format "owner/repo")
  //   2. Vercel-injected source repo (VERCEL_GIT_REPO_OWNER/SLUG) so notes are
  //      stored back into the very repository this app was deployed from —
  //      no manual GITHUB_REPO needed on Vercel.
  const repo =
    process.env.GITHUB_REPO ||
    (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
      ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
      : undefined);
  // Branch: explicit GITHUB_BRANCH, else the deployed branch, else main.
  const branch =
    process.env.GITHUB_BRANCH || process.env.VERCEL_GIT_COMMIT_REF || "main";
  const notesDir = process.env.NOTES_DIR || "notes";
  const attachDir = process.env.ATTACH_DIR || "attachment";
  if (!token) {
    throw new Error(
      "Missing environment variable GITHUB_TOKEN (required to write to the repo)"
    );
  }
  if (!repo) {
    throw new Error(
      "Cannot resolve target repository: set GITHUB_REPO, or deploy on Vercel from a GitHub repo (VERCEL_GIT_REPO_OWNER/SLUG)"
    );
  }
  return { token, repo, branch, notesDir, attachDir };
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function b64encode(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64");
}
function b64decode(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf-8");
}

// UTC timestamp for commit messages, format: YYYYMMDD-HH:mm:ss
function utcStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

// List directory contents; returns [] on 404
async function listDir(p: string): Promise<any[]> {
  const { token, repo, branch } = cfg();
  const url = `${API}/repos/${repo}/contents/${encodeURIComponent(
    p
  )}?ref=${branch}`;
  const res = await fetch(url, { headers: headers(token), cache: "no-store" });
  if (res.status === 404) return [];
  if (!res.ok)
    throw new Error(`Failed to list directory: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export const githubStore: NoteStore = {
  async listNotes(): Promise<NoteMeta[]> {
    const { notesDir } = cfg();
    const top = await listDir(notesDir);
    const dirs = top.filter((e) => e.type === "dir");
    const metas: NoteMeta[] = [];
    for (const d of dirs) {
      const id = d.name as string;
      const items = await listDir(`${notesDir}/${id}`);
      const hidden = items.some((f) => f.type === "file" && f.name === ".hidden");
      if (hidden) continue;
      const mdFile = items.find(
        (f) => f.type === "file" && f.name === `${id}.md`
      );
      if (!mdFile) continue;
      metas.push({ id, path: mdFile.path, sha: mdFile.sha });
    }
    return metas.sort((a, b) => (a.id < b.id ? 1 : -1));
  },

  async getNote(id: string): Promise<Note | null> {
    const { token, repo, branch, notesDir } = cfg();
    const p = `${notesDir}/${id}/${id}.md`;
    const url = `${API}/repos/${repo}/contents/${encodeURIComponent(
      p
    )}?ref=${branch}`;
    const res = await fetch(url, { headers: headers(token), cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok)
      throw new Error(`Failed to read note: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as any;
    return {
      id,
      path: p,
      sha: data.sha,
      content: b64decode((data.content || "").replace(/\n/g, "")),
    };
  },

  async putNote(
    id: string,
    content: string,
    sha?: string,
    mode: SaveMode = "auto"
  ): Promise<{ sha?: string }> {
    const { token, repo, branch, notesDir } = cfg();
    const p = `${notesDir}/${id}/${id}.md`;
    const url = `${API}/repos/${repo}/contents/${encodeURIComponent(p)}`;
    // auto-save -> docs(auto), manual save -> docs(manual)
    const scope = mode === "manual" ? "manual" : "auto";
    const body: any = {
      message: `docs(${scope}): ${mode}-save ${utcStamp()}`,
      content: b64encode(content),
      branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`Failed to save note: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as any;
    return { sha: data.content.sha };
  },

  async hideNote(id: string): Promise<void> {
    const { token, repo, branch, notesDir } = cfg();
    const p = `${notesDir}/${id}/.hidden`;
    const url = `${API}/repos/${repo}/contents/${encodeURIComponent(p)}`;
    // A sha is required if the file already exists
    const getRes = await fetch(`${url}?ref=${branch}`, {
      headers: headers(token),
      cache: "no-store",
    });
    let sha: string | undefined;
    if (getRes.ok) sha = (await getRes.json())?.sha;
    const body: any = {
      message: `docs(manual): manual-delete ${utcStamp()}`,
      content: b64encode(""),
      branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`Failed to hide note: ${res.status} ${await res.text()}`);
  },

  async uploadImage(
    noteId: string,
    filename: string,
    base64Content: string
  ): Promise<{ path: string; url: string }> {
    const { token, repo, branch, notesDir, attachDir } = cfg();
    const safe = filename.split("/").pop() || filename;
    const p = `${notesDir}/${noteId}/${attachDir}/${safe}`;
    const url = `${API}/repos/${repo}/contents/${encodeURIComponent(p)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `docs(auto): auto-save ${utcStamp()}`,
        content: base64Content,
        branch,
      }),
    });
    if (!res.ok)
      throw new Error(`Failed to upload image: ${res.status} ${await res.text()}`);
    // Serve through the in-app /api/asset route so image links work both
    // locally and in production.
    return {
      path: p,
      url: `/api/asset/${encodeURIComponent(noteId)}/${encodeURIComponent(
        safe
      )}`,
    };
  },

  async getImage(noteId: string, filename: string): Promise<Buffer | null> {
    const { token, repo, branch, notesDir, attachDir } = cfg();
    const safe = filename.split("/").pop() || filename;
    const p = `${notesDir}/${noteId}/${attachDir}/${safe}`;
    const url = `${API}/repos/${repo}/contents/${encodeURIComponent(
      p
    )}?ref=${branch}`;
    const res = await fetch(url, {
      headers: {
        ...headers(token),
        // Request raw bytes to avoid large files being truncated by the Contents API
        Accept: "application/vnd.github.raw",
      },
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok)
      throw new Error(`Failed to read image: ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  },
};
