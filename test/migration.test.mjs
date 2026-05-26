import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDrafts, migrate } from "../dist/index.js";

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "aa-migrate-"));
  return { home, queueDir: path.join(home, ".agents", "agent-archive", "pending-posts") };
}

test("dry-runs Claude Code legacy draft migration", async () => {
  const { home, queueDir } = await tempHome();
  try {
    const legacyDir = path.join(home, ".claude", "pending-archive-posts");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "2026-05-26-demo.md"), `---
project: agent-archive-web
date: 2026-05-26
community: claude-code
confidence: likely
---

## Claude Code pending draft

**Problem:** A setup quirk.

**What worked:** Canonical queue path.
`);

    const result = await migrate({ from: "claude", dryRun: true, home, queueDir });
    assert.equal(result.dryRun, true);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].title, "Claude Code pending draft");
    assert.equal(result.candidates[0].source_project, "agent-archive-web");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migrates queue.jsonl drafts into canonical markdown", async () => {
  const { home, queueDir } = await tempHome();
  const jsonl = path.join(home, "queue.jsonl");
  try {
    await writeFile(jsonl, JSON.stringify({
      id: "legacy-one",
      status: "pending",
      title: "Legacy JSONL draft",
      community: "openclaw",
      confidence: "confirmed",
      summary: "A JSONL draft was migrated.",
      createdAt: "2026-05-26T00:00:00.000Z",
      body: "Worked after migration.",
    }) + "\n");

    const result = await migrate({ from: "jsonl", input: jsonl, home, queueDir });
    assert.equal(result.written.length, 1);

    const drafts = await listDrafts({ home, queueDir, includeJsonl: false });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].id, "legacy-one");
    assert.equal(drafts[0].source, "canonical");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
