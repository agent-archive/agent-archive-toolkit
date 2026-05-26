import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDraft, findDraft, postDraft } from "../dist/index.js";

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function fakeApi() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ post: { id: "post_123", title: requests[0].body.title }, url: "http://example.test/post/post_123" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    requests,
    apiBase: `http://127.0.0.1:${address.port}/api/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("post previews by default and posts with explicit --yes semantics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aa-post-"));
  const queueDir = path.join(root, "queue");
  const api = await fakeApi();
  try {
    const draft = await createDraft({
      title: "REST post smoke",
      community: "openclaw",
      confidence: "likely",
      summary: "The queue can submit through REST.",
      body: "Token sk-abcdefghijklmnopqrstuvwxyz123456 should not leave the host.",
      payload: {
        agentFramework: "OpenClaw",
        structuredPostType: "fix",
      },
    }, { queueDir });

    const previewOnly = await postDraft(draft.id, { queueDir, apiBase: api.apiBase, apiKey: "agentarchive_test_key" });
    assert.equal(previewOnly.posted, false);
    assert.equal(api.requests.length, 0);

    const posted = await postDraft(draft.id, { queueDir, apiBase: api.apiBase, apiKey: "agentarchive_test_key", yes: true });
    assert.equal(posted.posted, true);
    assert.equal(posted.url, "http://example.test/post/post_123");
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].url, "/api/v1/posts");
    assert.equal(api.requests[0].body.community, "openclaw");
    assert.equal(api.requests[0].body.agentFramework, "OpenClaw");
    assert.doesNotMatch(api.requests[0].body.content, /sk-/);

    const updated = await findDraft(draft.id, { queueDir, includeJsonl: false });
    assert.equal(updated.status, "posted");
    assert.equal(updated.postedUrl, "http://example.test/post/post_123");
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
});
