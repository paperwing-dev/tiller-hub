# Durable Object Cost Optimizations

Durable Objects bill on two axes: **requests** ($0.15/M, 1M free) and **duration** ($12.50/M GB-seconds, 400K GB-s free). Duration is wall-clock time the DO is awake, multiplied by memory allocation. The current workspace sync patterns keep the DO awake longer than necessary due to sequential I/O.

## Current cost profile (20 create/delete cycles/day, 500-file workspace)

| Phase              | DO Requests/day | DO Duration (GB-s/day) |
| ------------------ | --------------- | ---------------------- |
| initFromTarball    | 20              | 12.8                   |
| syncDown (boot)    | 100             | 7.7                    |
| syncUp (5-min)     | 240             | 30.7                   |
| destroy            | 40              | 5.1                    |
| **Monthly total**  | **~12,000**     | **~1,700 GB-s**        |

Well within free tier today, but the sequential patterns are wasteful and will bite at scale.

---

## 1. Parallelize `batchReadWorkspaceFiles`

**File:** `api/sandbox-do.ts:146-152`

**Problem:** Reads files one at a time in a sequential loop. Each R2 read is a network call, and serializing them keeps the DO awake for the sum of all latencies.

**Current:**
```typescript
async batchReadWorkspaceFiles(paths: string[]): Promise<{ path: string; content: string | null }[]> {
    const results: { path: string; content: string | null }[] = [];
    for (const p of paths) {
      const content = await this.workspace.readFile(p);
      results.push({ path: p, content });
    }
    return results;
}
```

**Proposed:**
```typescript
async batchReadWorkspaceFiles(paths: string[]): Promise<{ path: string; content: string | null }[]> {
    return Promise.all(paths.map(async (p) => ({
      path: p,
      content: await this.workspace.readFile(p),
    })));
}
```

**Impact:** For batches of 50 files where some hit R2, this could cut duration by 5-10x per batch. SQLite reads are already fast, but R2 reads (~10-50ms each) benefit significantly from parallelism.

---

## 2. Parallelize `writeWorkspaceFiles` for R2-bound files

**File:** `api/sandbox-do.ts:118-122`

**Problem:** Same sequential pattern as reads. Each `writeFile` is awaited individually, serializing R2 writes for large files.

**Current:**
```typescript
async writeWorkspaceFiles(files: { path: string; content: string }[]): Promise<void> {
    for (const f of files) {
      await this.workspace.writeFile(f.path, f.content);
    }
}
```

**Proposed:**
```typescript
async writeWorkspaceFiles(files: { path: string; content: string }[]): Promise<void> {
    await Promise.all(files.map((f) => this.workspace.writeFile(f.path, f.content)));
}
```

**Caveat:** The Workspace class uses SQLite internally for file metadata. If `writeFile` does a SQLite write as part of its operation, concurrent writes could contend on the single-writer lock. Test this — if it causes issues, split into parallel R2 writes + sequential SQLite metadata updates. Inline files (<1MB, SQLite-only) are fast enough that parallelism doesn't help much anyway.

---

## 3. Single `syncDiff` RPC to replace manifest + batch reads

**Files:** `api/workspace.ts`, `api/sandbox-do.ts`, `container/workspace-sync.mjs`

**Problem:** Each container boot makes multiple round-trips to the DO:

```
GET  /manifest                    → 1 DO request
POST /files  (batch 1 of 50)      → 1 DO request
POST /files  (batch 2 of 50)      → 1 DO request
...
```

Each HTTP request is a separate Worker invocation + DO request. For a restart with 200 changed files, that's 5 DO requests where 1 would suffice.

**Proposed:** Add a single `syncDiff` RPC method:

```typescript
// sandbox-do.ts
async syncDiff(localManifest: ManifestEntry[]): Promise<{
    download: { path: string; content: string }[];
    delete: string[];
}> {
    const remote = this.getManifest();
    const remoteByPath = new Map(remote.map(f => [f.path, f]));
    const localByPath = new Map(localManifest.map(f => [f.path, f]));

    // Files to download: remote has it, local doesn't or is stale
    const toDownload: string[] = [];
    for (const [path, rf] of remoteByPath) {
        const lf = localByPath.get(path);
        if (!lf || lf.size !== rf.size || lf.mtime < rf.mtime) {
            toDownload.push(path);
        }
    }

    // Files to delete: local has it, remote doesn't
    const toDelete = [...localByPath.keys()].filter(p => !remoteByPath.has(p));

    // Read all needed files (parallelized)
    const download = await Promise.all(
        toDownload.map(async (p) => ({
            path: p,
            content: await this.workspace.readFile(p),
        }))
    ).then(files => files.filter(f => f.content !== null) as { path: string; content: string }[]);

    return { download, delete: toDelete };
}
```

```javascript
// workspace-sync.mjs — syncDown becomes a single call
async function syncDown() {
    const local = walkLocal(WORKSPACE);
    const localManifest = Object.entries(local).map(([path, info]) => ({
        path, size: info.size, mtime: info.mtimeMs,
    }));

    const resp = await safeFetch(`${API_BASE}/sync-diff`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: localManifest }),
    });

    const { download, delete: toDelete } = await resp.json();

    for (const f of download) {
        const localPath = join(WORKSPACE, f.path);
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, f.content, "utf-8");
    }

    for (const p of toDelete) {
        try { unlinkSync(join(WORKSPACE, p)); } catch {}
    }
}
```

**Impact:** Reduces syncDown from 2-11 DO requests to 1. Eliminates Worker → DO round-trip latency for each batch. For 20 boots/day, saves ~80-200 DO requests/day and cuts boot time.

**Limitation:** Response size. If the workspace has many changed files, the single response could be large. Consider a size cap (e.g., if diff > 10MB, fall back to tar download).

---

## 4. Apply same parallelization to `deleteWorkspaceFiles`

**File:** `api/sandbox-do.ts:128-131`

**Current:**
```typescript
async deleteWorkspaceFiles(paths: string[]): Promise<void> {
    for (const p of paths) {
      await this.workspace.deleteFile(p);
    }
}
```

**Proposed:**
```typescript
async deleteWorkspaceFiles(paths: string[]): Promise<void> {
    await Promise.all(paths.map((p) => this.workspace.deleteFile(p)));
}
```

Same rationale as reads/writes — `deleteFile` may hit R2 to remove large file blobs.

---

## Priority order

1. **Parallelize batch reads** — easiest change, biggest duration win per DO request
2. **Parallelize batch writes/deletes** — same pattern, quick follow-up
3. **`syncDiff` RPC** — reduces request count, cuts boot latency, but requires changes in both DO and container sync script
