import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDraft,
  findDraft,
  listDrafts,
  parseDraftMarkdown,
  previewDraft,
  updateDraftStatus,
  validateDraft,
} from "../dist/index.js";

async function tempQueue() {
  const root = await mkdtemp(path.join(tmpdir(), "aa-toolkit-"));
  return { root, queueDir: path.join(root, "queue") };
}

test("creates, lists, previews, and dismisses portable drafts", async () => {
  const { root, queueDir } = await tempQueue();
  try {
    const draft = await createDraft({
      title: "Fix hidden MCP auth failure",
      community: "claude-code",
      confidence: "confirmed",
      summary: "Bearer auth was missing from the MCP server config.",
      body: "User email test@example.com and path /Users/nicholasgavin/project were redacted.",
      source_agent: "claude-code",
      source_adapter: "claude-code-agent-archive",
      tags: ["mcp", "auth"],
    }, { queueDir });

    assert.equal(draft.status, "pending");
    assert.equal(draft.sanitized, true);
    assert.ok(existsSync(draft.filePath));

    const raw = await readFile(draft.filePath, "utf8");
    assert.match(raw, /schema_version/);
    assert.doesNotMatch(raw, /test@example.com/);
    assert.doesNotMatch(raw, /\/Users\/nicholasgavin\//);

    const drafts = await listDrafts({ queueDir, includeJsonl: false });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].id, draft.id);

    const found = await findDraft(draft.id, { queueDir, includeJsonl: false });
    const preview = previewDraft(found);
    assert.equal(preview.ok, true);
    assert.match(preview.markdown, /Fix hidden MCP auth failure/);
    assert.match(preview.markdown, /\[REDACTED_EMAIL\]/);

    const dismissed = await updateDraftStatus(draft.id, "dismissed", { dismissReason: "duplicate" }, { queueDir, includeJsonl: false });
    assert.equal(dismissed.status, "dismissed");
    assert.ok(dismissed.dismissedAt);
    assert.equal(dismissed.dismissReason, "duplicate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses frontmatter and validates required fields", () => {
  const parsed = parseDraftMarkdown(`---
id: "aa-test"
status: "pending"
title: "Portable queue"
community: "openclaw"
confidence: "likely"
summary: "Portable draft schema works."
createdAt: "2026-05-26T00:00:00.000Z"
payload_json: "{\\"structuredPostType\\":\\"fix\\"}"
---

# Portable queue

## Body
Details.
`, "/tmp/draft.md");

  assert.equal(parsed.id, "aa-test");
  assert.equal(parsed.payload.structuredPostType, "fix");
  assert.deepEqual(validateDraft(parsed), []);

  const invalid = { ...parsed, title: "", confidence: "certain" };
  assert.deepEqual(validateDraft(invalid), [
    "title is required",
    "confidence must be one of confirmed, likely, experimental",
  ]);
});
