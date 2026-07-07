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
  // Data branch: the branch notes are committed to. Kept SEPARATE from the
  // code/deploy branch on purpose so that a fork-sync workflow which
  // force-pushes the code branch (e.g. main/master) can never overwrite a
  // user's notes. Resolution order:
  //   1. GITHUB_DATA_BRANCH (explicit override)
  //   2. GITHUB_BRANCH (legacy/back-compat override)
  //   3. "notes-data" (dedicated data branch — do NOT include this in any
  //      fork-sync matrix so notes survive upstream syncs)
  const branch =
    process.env.GITHUB_DATA_BRANCH ||
    process.env.GITHUB_BRANCH ||
    "notes-data";
  // The branch new data branches are forked from when they don't yet exist.
  const baseBranch =
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
  return { token, repo, branch, baseBranch, notesDir, attachDir };
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

// Ensure the dedicated data branch exists. If it doesn't, create it by
// branching off the base (code/deploy) branch. This lets notes live on a
// branch that a fork-sync workflow never force-pushes, so syncing upstream
// code can't wipe a user's notes. Runs at most one extra API call once the
// branch exists (a cheap ref lookup that 404s -> create).
let _dataBranchEnsured = false;
async function ensureDataBranch(): Promise<void> {
  if (_dataBranchEnsured) return;
  const { token, repo, branch, baseBranch } = cfg();
  // Does the data branch already exist?
  const refUrl = `${API}/repos/${repo}/git/ref/${encodeURIComponent(
    `heads/${branch}`
  )}`;
  const refRes = await fetch(refUrl, {
    headers: headers(token),
    cache: "no-store",
  });
  if (refRes.ok) {
    _dataBranchEnsured = true;
    return;
  }
  if (refRes.status !== 404) {
    throw new Error(
      `Failed to check data branch: ${refRes.status} ${await refRes.text()}`
    );
  }
  // Data branch missing: look up the base branch's tip commit sha.
  const baseUrl = `${API}/repos/${repo}/git/ref/${encodeURIComponent(
    `heads/${baseBranch}`
  )}`;
  const baseRes = await fetch(baseUrl, {
    headers: headers(token),
    cache: "no-store",
  });
  if (!baseRes.ok)
    throw new Error(
      `Failed to resolve base branch "${baseBranch}" to create data branch "${branch}": ${baseRes.status} ${await baseRes.text()}`
    );
  const baseSha = (await baseRes.json())?.object?.sha;
  if (!baseSha)
    throw new Error(`Could not read tip sha of base branch "${baseBranch}"`);
  // Create the data branch pointing at the base branch tip.
  const createRes = await fetch(`${API}/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  // 201 created, or 422 if it raced and now exists — both are fine.
  if (!createRes.ok && createRes.status !== 422)
    throw new Error(
      `Failed to create data branch "${branch}": ${createRes.status} ${await createRes.text()}`
    );
  _dataBranchEnsured = true;
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
    await ensureDataBranch();
    const { token, repo, branch, notesDir } = cfg();
    const p = `${notesDir}/${id}/${id}.md`;
    const url = `${API}/repos/${repo}/contents/${encodeURIComponent(p)}`;
    // auto-save -> docs(auto), manual save -> docs(manual)
    const scope = mode === "manual" ? "manual" : "auto";
    const body: any = {
      // The [vercel-skip] tag is matched by vercel.json's ignoreCommand to
      // prevent a redeploy on every note save. Since notes now commit to the
      // dedicated `notes-data` branch (not the deploy branch), Vercel already
      // won't redeploy on saves; this tag is kept as a harmless double-safeguard
      // in case the data branch is ever pointed back at the deploy branch.
      message: `docs(${scope}): ${mode}-save ${utcStamp()} [vercel-skip]`,
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
    await ensureDataBranch();
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
      message: `docs(manual): manual-delete ${utcStamp()} [vercel-skip]`,
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
    await ensureDataBranch();
    const { token, repo, branch, notesDir, attachDir } = cfg();
    const safe = filename.split("/").pop() || filename;
    const p = `${notesDir}/${noteId}/${attachDir}/${safe}`;
    const url = `${API}/repos/${repo}/contents/${encodeURIComponent(p)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `docs(auto): auto-save ${utcStamp()} [vercel-skip]`,
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
