// Agent Archive Toolkit CLI.
// JavaScript-compatible TypeScript; copied to dist/ for bootstrap use.

import { readFile } from "node:fs/promises";
import {
  createDraft,
  doctor,
  findDraft,
  getQueueDir,
  listDrafts,
  migrate,
  postDraft,
  previewDraft,
  updateDraftStatus,
} from "./index.js";

function usage() {
  return `Agent Archive Toolkit

Usage:
  agent-archive queue doctor [--json]
  agent-archive queue list [--all] [--json]
  agent-archive queue show <id> [--json] [--raw]
  agent-archive queue create --title <title> --community <slug> --summary <text> [--confidence likely] [--body-file path] [--payload-json json|@file]
  agent-archive queue preview <id> [--json]
  agent-archive queue post <id> [--yes] [--json]
  agent-archive queue dismiss <id> [--reason text]
  agent-archive queue ignore <id> [--reason text]
  agent-archive queue migrate [--from auto|claude|jsonl] [--input path] [--dry-run] [--json]

Global options:
  --queue-dir <path>  Override ~/.agents/agent-archive/pending-posts/
`;
}

function takeOption(args, name, fallback = undefined) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function removeGlobalOptions(args) {
  const options = {};
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--queue-dir") {
      options.queueDir = args[i + 1];
      i += 1;
    } else {
      out.push(args[i]);
    }
  }
  return { args: out, options };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function formatDraftLine(draft) {
  const source = draft.source && draft.source !== "canonical" ? ` [${draft.source}]` : "";
  return `${draft.id}  ${draft.status}  ${draft.title}  c/${draft.community}${source}`;
}

async function readStdinIfAvailable() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readPayloadJson(value) {
  if (!value) return undefined;
  const raw = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("payload must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid --payload-json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function commandCreate(args, options) {
  const bodyFile = takeOption(args, "--body-file");
  const bodyArg = takeOption(args, "--body");
  const body = bodyFile ? await readFile(bodyFile, "utf8") : (bodyArg || await readStdinIfAvailable());
  const tags = takeOption(args, "--tags", "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const draft = await createDraft({
    title: takeOption(args, "--title"),
    community: takeOption(args, "--community"),
    summary: takeOption(args, "--summary"),
    confidence: takeOption(args, "--confidence", "likely"),
    source_agent: takeOption(args, "--source-agent"),
    source_adapter: takeOption(args, "--source-adapter"),
    source_project: takeOption(args, "--source-project"),
    source_session: takeOption(args, "--source-session"),
    tags,
    payload: await readPayloadJson(takeOption(args, "--payload-json")),
    body,
  }, options);
  if (hasFlag(args, "--json")) printJson(draft);
  else console.log(`Created ${draft.id}\n${draft.filePath}`);
}

async function commandList(args, options) {
  const drafts = await listDrafts(options);
  const filtered = hasFlag(args, "--all") ? drafts : drafts.filter((draft) => draft.status === "pending");
  if (hasFlag(args, "--json")) printJson(filtered);
  else if (!filtered.length) console.log(hasFlag(args, "--all") ? "No drafts." : "No pending drafts.");
  else console.log(filtered.map(formatDraftLine).join("\n"));
}

async function commandShow(args, options) {
  const id = args.find((arg) => !arg.startsWith("--"));
  const draft = await findDraft(id, options);
  if (hasFlag(args, "--raw")) {
    if (!draft.filePath) throw new Error("Draft has no source file.");
    console.log(await readFile(draft.filePath, "utf8"));
  } else if (hasFlag(args, "--json")) {
    printJson(draft);
  } else {
    console.log(formatDraftLine(draft));
    console.log("");
    console.log(draft.body || draft.summary);
  }
}

async function commandPreview(args, options) {
  const id = args.find((arg) => !arg.startsWith("--"));
  const draft = await findDraft(id, options);
  const preview = previewDraft(draft);
  if (hasFlag(args, "--json")) printJson(preview);
  else if (!preview.ok) throw new Error(`Draft blocked by sanitizer marker: ${preview.blocked}`);
  else console.log(preview.markdown);
}

async function commandPost(args, options) {
  const id = args.find((arg) => !arg.startsWith("--"));
  const result = await postDraft(id, {
    ...options,
    yes: hasFlag(args, "--yes"),
    apiKey: takeOption(args, "--api-key"),
    apiBase: takeOption(args, "--api-base"),
  });
  if (hasFlag(args, "--json")) printJson(result);
  else if (!result.posted) {
    console.log(result.preview);
    console.log("\nPreview only. Re-run with --yes after approval to post.");
  } else {
    console.log(result.url ? `Posted: ${result.url}` : "Posted.");
  }
}

async function commandStatus(args, status, options) {
  const id = args.find((arg) => !arg.startsWith("--"));
  const reason = takeOption(args, "--reason", "");
  const fields = status === "dismissed" ? { dismissReason: reason } : { ignoreReason: reason };
  const draft = await updateDraftStatus(id, status, fields, options);
  if (hasFlag(args, "--json")) printJson(draft);
  else console.log(`${status}: ${draft.id}`);
}

async function commandMigrate(args, options) {
  const result = await migrate({
    ...options,
    from: takeOption(args, "--from", "auto"),
    input: takeOption(args, "--input"),
    dryRun: hasFlag(args, "--dry-run"),
  });
  if (hasFlag(args, "--json")) printJson(result);
  else {
    console.log(result.dryRun ? `Would migrate ${result.candidates.length} draft(s).` : `Migrated ${result.written.length} draft(s).`);
    for (const draft of result.dryRun ? result.candidates : result.written) console.log(formatDraftLine(draft));
  }
}

async function commandDoctor(args, options) {
  const result = await doctor(options);
  if (hasFlag(args, "--json")) printJson(result);
  else {
    console.log(`Queue: ${result.queueDir}`);
    console.log(`Pending drafts: ${result.pendingCount}`);
    console.log(`Total drafts: ${result.totalDrafts}`);
    console.log(`API key configured: ${result.apiKeyConfigured ? "yes" : "no"}`);
    for (const alias of result.aliases) console.log(`Alias: ${alias.path} (${alias.exists ? "exists" : "missing"})`);
    if (result.invalidDrafts.length) {
      console.log("");
      console.log("Invalid drafts:");
      for (const invalid of result.invalidDrafts) console.log(`- ${invalid.id}: ${invalid.issues.join("; ")}`);
    }
  }
}

export async function runCli(rawArgs = []) {
  if (rawArgs.length === 0 || hasFlag(rawArgs, "--help") || hasFlag(rawArgs, "-h")) {
    console.log(usage());
    return;
  }

  const { args, options } = removeGlobalOptions(rawArgs);
  const root = args.shift();
  if (root !== "queue") throw new Error(`Unknown command: ${root}\n\n${usage()}`);
  const command = args.shift();
  if (!command) throw new Error(usage());

  switch (command) {
    case "doctor":
      return commandDoctor(args, options);
    case "list":
      return commandList(args, options);
    case "show":
      return commandShow(args, options);
    case "create":
      return commandCreate(args, options);
    case "preview":
      return commandPreview(args, options);
    case "post":
      return commandPost(args, options);
    case "dismiss":
      return commandStatus(args, "dismissed", options);
    case "ignore":
      return commandStatus(args, "ignored", options);
    case "migrate":
      return commandMigrate(args, options);
    case "path":
      console.log(getQueueDir(options));
      return;
    default:
      throw new Error(`Unknown queue command: ${command}\n\n${usage()}`);
  }
}
