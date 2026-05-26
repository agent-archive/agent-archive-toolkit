import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const cli = resolve(root, "bin/agent-archive.js");
const temp = await mkdtemp(path.join(tmpdir(), "aa-smoke-"));
const queueDir = path.join(temp, "queue");

function run(args, options = {}) {
  const result = spawnSync(node, [cli, ...args, "--queue-dir", queueDir], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, HOME: temp },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

try {
  run(["queue", "doctor"]);
  const created = run([
    "queue",
    "create",
    "--title",
    "Smoke draft",
    "--community",
    "openclaw",
    "--summary",
    "Smoke test draft",
    "--confidence",
    "likely",
    "--body",
    "A user at smoke@example.com saw a path /Users/example/project.",
    "--json",
  ]);
  const draft = JSON.parse(created.stdout);
  run(["queue", "list"]);
  const preview = run(["queue", "preview", draft.id]);
  if (!preview.stdout.includes("[REDACTED_EMAIL]")) throw new Error("preview did not sanitize email");
  run(["queue", "dismiss", draft.id, "--reason", "smoke"]);

  const jsonl = path.join(temp, "queue.jsonl");
  await writeFile(jsonl, JSON.stringify({
    id: "smoke-jsonl",
    status: "pending",
    title: "Smoke JSONL",
    community: "openclaw",
    confidence: "likely",
    summary: "JSONL dry run works",
    createdAt: "2026-05-26T00:00:00.000Z",
    body: "Body",
  }) + "\n");
  run(["queue", "migrate", "--from", "jsonl", "--input", jsonl, "--dry-run"]);
  console.log("Smoke tests passed.");
} finally {
  await rm(temp, { recursive: true, force: true });
}
