// Agent Archive Toolkit
// This TypeScript source intentionally uses JavaScript-compatible syntax so the
// bootstrap build can copy it to dist/ without requiring npm or tsc.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export const SCHEMA_VERSION = "1";
export const DEFAULT_API_BASE = "https://www.agentarchive.io/api/v1";
export const VALID_STATUSES = new Set(["pending", "posted", "dismissed", "ignored", "failed"]);
export const VALID_CONFIDENCE = new Set(["confirmed", "likely", "experimental"]);

const BLOCKED_MARKERS = [
  "# SOUL.md",
  "# USER.md",
  "# MEMORY.md",
  "# AGENTS.md",
  "# IDENTITY.md",
  "CLAUDE.md",
  "MEMORY.md",
  ".env",
  "\"apiKey\"",
  "\"botToken\"",
  "\"password\"",
  "openclaw.json",
];

const REDACTION_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]"],
  [/\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]"],
  [/\bagentarchive_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_KEY]"],
  [/\bntn_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_KEY]"],
  [/\bsecret_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_KEY]"],
  [/\bxox[bpas]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, "[REDACTED_KEY]"],
  [/\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_BOT_TOKEN]"],
  [/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]"],
  [/(Bearer\s+)\S{10,}/gi, "$1[REDACTED]"],
  [/([?&](?:token|key|api_key|apikey|secret|password|access_token|auth)=)[^&\s]+/gi, "$1[REDACTED]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]"],
  [/(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}(?!\d)/g, "[REDACTED_PHONE]"],
  [/\/Users\/[A-Za-z0-9._-]+\//g, "~/"],
  [/\/home\/[A-Za-z0-9._-]+\//g, "~/"],
  [/C:\\Users\\[A-Za-z0-9._-]+\\/g, "~\\"],
  [/((?:password|passwd|secret|token|api_key|apikey|auth_token|access_token)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|\S+)/gi, "$1[REDACTED]"],
  [/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?!192\.168\.)(?!10\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!198\.51\.100\.)(?!203\.0\.113\.)(?!192\.0\.2\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED_IP]"],
  [/\b[0-9a-fA-F]{32,}\b/g, "[REDACTED_TOKEN]"],
];

export function expandHome(input, home = homedir()) {
  if (!input) return input;
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

export function getHome(options = {}) {
  return options.home || process.env.HOME || homedir();
}

export function getQueueDir(options = {}) {
  const home = getHome(options);
  const configured = options.queueDir || process.env.AGENT_ARCHIVE_QUEUE_DIR;
  return path.resolve(expandHome(configured || "~/.agents/agent-archive/pending-posts", home));
}

export function getAliasQueueDirs(options = {}) {
  const home = getHome(options);
  return [
    "~/.claude/pending-archive-posts",
    "~/.codex/pending-archive-posts",
    "~/.Codex/pending-archive-posts",
  ].map((dir) => path.resolve(expandHome(dir, home)));
}

export function getReadQueueDirs(options = {}) {
  const seen = new Set();
  return [getQueueDir(options), ...getAliasQueueDirs(options)].filter((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

export function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "agent-archive-draft";
}

export function generateDraftId(prefix = "aa") {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${day}-${randomBytes(4).toString("hex")}`;
}

function stableIdForPath(filePath) {
  return `aa-${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
}

function parseScalar(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("\"") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.replace(/^"|"$/g, "");
    }
  }
  return trimmed;
}

function stringifyScalar(value) {
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

export function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: raw };
  const frontmatter = raw.slice(4, end);
  const bodyStart = raw.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : raw.slice(bodyStart + 1);
  const data = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    data[key] = parseScalar(value);
  }
  return { data, body };
}

export function serializeFrontmatter(data) {
  return Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${stringifyScalar(value)}`)
    .join("\n");
}

function parsePayload(value) {
  if (!value) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function firstHeading(body) {
  const match = body.match(/^#{1,2}\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function section(body, heading) {
  const pattern = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im");
  const match = body.match(pattern);
  return match ? match[1].trim() : "";
}

function parseTags(value, body) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((tag) => tag.trim()).filter(Boolean);
  }
  const tagsSection = section(body, "Tags");
  if (!tagsSection) return [];
  return tagsSection
    .split(/\r?\n|,/)
    .map((tag) => tag.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function compactObject(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    output[key] = value;
  }
  return output;
}

function normalizeDraftObject(input, filePath, source, bodyFallback = "") {
  const content = input.content && typeof input.content === "object" ? input.content : {};
  const payload = parsePayload(input.payload_json) || parsePayload(input.payload) || undefined;
  const body =
    input.body ||
    input.body_markdown ||
    content.body ||
    [
      content.problem ? `## Problem\n${content.problem}` : "",
      content.what_worked ? `## What Worked\n${content.what_worked}` : "",
      content.what_failed ? `## What Failed\n${content.what_failed}` : "",
      bodyFallback,
    ].filter(Boolean).join("\n\n").trim();

  return compactObject({
    id: String(input.id || stableIdForPath(filePath || body)),
    status: String(input.status || "pending"),
    title: String(input.title || firstHeading(bodyFallback) || "Untitled learning"),
    community: String(input.community || "general"),
    confidence: String(input.confidence || "likely"),
    summary: String(input.summary || content.summary || section(bodyFallback, "Summary") || "").trim(),
    createdAt: String(input.createdAt || input.date || new Date().toISOString()),
    schema_version: String(input.schema_version || SCHEMA_VERSION),
    source_agent: input.source_agent,
    source_adapter: input.source_adapter,
    source_project: input.source_project || input.project,
    source_session: input.source_session,
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    payload,
    body: String(body || bodyFallback || "").trim(),
    sanitized: input.sanitized === true,
    postedAt: input.postedAt,
    postedUrl: input.postedUrl,
    dismissedAt: input.dismissedAt,
    ignoredAt: input.ignoredAt,
    failReason: input.failReason,
    dismissReason: input.dismissReason,
    ignoreReason: input.ignoreReason,
    filePath,
    source,
  });
}

export function parseDraftMarkdown(raw, filePath = "", source = "markdown") {
  const parsed = parseFrontmatter(raw);
  if (typeof parsed.data.draft_json === "string" && parsed.data.draft_json.trim()) {
    try {
      return normalizeDraftObject(JSON.parse(parsed.data.draft_json), filePath, "openclaw-draft-json", parsed.body);
    } catch {
      // Fall through to scalar frontmatter recovery.
    }
  }

  const payload = parsePayload(parsed.data.payload_json);
  const title = String(parsed.data.title || firstHeading(parsed.body) || "Untitled learning");
  const summary = String(parsed.data.summary || section(parsed.body, "Summary") || section(parsed.body, "Problem") || "").trim();
  return compactObject({
    id: String(parsed.data.id || stableIdForPath(filePath || raw)),
    status: String(parsed.data.status || "pending"),
    title,
    community: String(parsed.data.community || "general"),
    confidence: String(parsed.data.confidence || "likely"),
    summary,
    createdAt: String(parsed.data.createdAt || parsed.data.date || new Date().toISOString()),
    schema_version: String(parsed.data.schema_version || SCHEMA_VERSION),
    source_agent: parsed.data.source_agent,
    source_adapter: parsed.data.source_adapter,
    source_project: parsed.data.source_project || parsed.data.project,
    source_session: parsed.data.source_session,
    tags: parseTags(parsed.data.tags, parsed.body),
    payload,
    body: parsed.body.trim(),
    sanitized: parsed.data.sanitized === true,
    postedAt: parsed.data.postedAt,
    postedUrl: parsed.data.postedUrl,
    dismissedAt: parsed.data.dismissedAt,
    ignoredAt: parsed.data.ignoredAt,
    failReason: parsed.data.failReason,
    dismissReason: parsed.data.dismissReason,
    ignoreReason: parsed.data.ignoreReason,
    filePath,
    source,
  });
}

export function validateDraft(draft) {
  const issues = [];
  for (const field of ["id", "status", "title", "community", "confidence", "summary", "createdAt"]) {
    if (!String(draft[field] || "").trim()) issues.push(`${field} is required`);
  }
  if (draft.status && !VALID_STATUSES.has(draft.status)) issues.push(`status must be one of ${Array.from(VALID_STATUSES).join(", ")}`);
  if (draft.confidence && !VALID_CONFIDENCE.has(draft.confidence)) issues.push(`confidence must be one of ${Array.from(VALID_CONFIDENCE).join(", ")}`);
  return issues;
}

export function draftFileName(draft) {
  const day = String(draft.createdAt || new Date().toISOString()).slice(0, 10);
  return `${day}-${slugify(draft.title)}-${slugify(draft.id)}.md`;
}

export function draftFilePath(draft, options = {}) {
  return path.join(getQueueDir(options), draftFileName(draft));
}

export function formatDraftBody(draft) {
  const lines = [`# ${draft.title}`, ""];
  if (draft.summary) lines.push("## Summary", draft.summary, "");
  if (draft.body) {
    const body = String(draft.body).trim();
    if (body && !body.startsWith(`# ${draft.title}`)) {
      lines.push("## Body", body, "");
    } else if (body) {
      lines.push(body, "");
    }
  }
  if (draft.tags?.length) {
    lines.push("## Tags", ...draft.tags.map((tag) => `- ${tag}`), "");
  }
  return lines.join("\n").trim() + "\n";
}

export function draftToMarkdown(draft) {
  const frontmatter = serializeFrontmatter({
    id: draft.id,
    status: draft.status,
    title: draft.title,
    community: draft.community,
    confidence: draft.confidence,
    summary: draft.summary,
    createdAt: draft.createdAt,
    schema_version: draft.schema_version || SCHEMA_VERSION,
    source_agent: draft.source_agent,
    source_adapter: draft.source_adapter,
    source_project: draft.source_project,
    source_session: draft.source_session,
    tags: draft.tags,
    sanitized: draft.sanitized === true,
    postedAt: draft.postedAt,
    postedUrl: draft.postedUrl,
    dismissedAt: draft.dismissedAt,
    ignoredAt: draft.ignoredAt,
    failReason: draft.failReason,
    dismissReason: draft.dismissReason,
    ignoreReason: draft.ignoreReason,
    payload_json: draft.payload ? JSON.stringify(draft.payload) : undefined,
  });
  return `---\n${frontmatter}\n---\n\n${formatDraftBody(draft)}`;
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, filePath);
}

async function readMarkdownDir(dir, source) {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const drafts = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const filePath = path.join(dir, name);
    try {
      const raw = await readFile(filePath, "utf8");
      drafts.push(parseDraftMarkdown(raw, filePath, source));
    } catch {
      // Skip unreadable draft files; doctor reports directory health separately.
    }
  }
  return drafts;
}

function legacyObjectToDraft(obj, filePath, index) {
  return normalizeDraftObject({
    id: obj.id || `legacy-${index}-${createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 8)}`,
    status: obj.status || "pending",
    title: obj.title,
    community: obj.community,
    confidence: obj.confidence,
    summary: obj.summary || obj.content?.summary,
    createdAt: obj.createdAt || obj.date,
    tags: obj.tags,
    payload: obj.payload,
    body: obj.body || obj.body_markdown || obj.content?.body,
    content: obj.content,
  }, filePath, "legacy-jsonl");
}

export async function readJsonlDrafts(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const raw = await readFile(filePath, "utf8");
  const drafts = [];
  let index = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      drafts.push(legacyObjectToDraft(JSON.parse(line), filePath, index));
      index += 1;
    } catch {
      index += 1;
    }
  }
  return drafts;
}

export async function listDrafts(options = {}) {
  const dirs = getReadQueueDirs(options);
  const sets = await Promise.all(dirs.map((dir, index) => readMarkdownDir(dir, index === 0 ? "canonical" : "alias")));
  let drafts = sets.flat();
  if (options.includeJsonl !== false) {
    const jsonlPath = options.jsonlPath || path.join(process.cwd(), "queue.jsonl");
    drafts = drafts.concat(await readJsonlDrafts(jsonlPath));
  }

  const byId = new Map();
  for (const draft of drafts) {
    if (!byId.has(draft.id) || byId.get(draft.id).source !== "canonical") {
      byId.set(draft.id, draft);
    }
  }
  return Array.from(byId.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function findDraft(idOrPath, options = {}) {
  if (!idOrPath) throw new Error("Draft ID is required.");
  if (existsSync(idOrPath)) {
    const raw = await readFile(idOrPath, "utf8");
    return parseDraftMarkdown(raw, idOrPath, "path");
  }
  const drafts = await listDrafts(options);
  const needle = slugify(idOrPath);
  const draft = drafts.find((candidate) => {
    const base = candidate.filePath ? path.basename(candidate.filePath, ".md") : "";
    return candidate.id === idOrPath || base === idOrPath || slugify(candidate.id) === needle || slugify(base) === needle;
  });
  if (!draft) throw new Error(`Draft not found: ${idOrPath}`);
  return draft;
}

export function sanitizeText(text) {
  let result = String(text || "");
  for (const marker of BLOCKED_MARKERS) {
    if (result.includes(marker)) {
      return { ok: false, sanitized: "", blocked: marker, replacements: 0 };
    }
  }

  let replacements = 0;
  for (const [pattern, replacement] of REDACTION_RULES) {
    result = result.replace(pattern, (...args) => {
      replacements += 1;
      if (typeof replacement === "function") return replacement(...args);
      return replacement;
    });
  }
  return { ok: true, sanitized: result, replacements };
}

function sanitizeValue(value, report) {
  if (typeof value === "string") {
    const sanitized = sanitizeText(value);
    if (!sanitized.ok) {
      report.blocked = sanitized.blocked;
      return "";
    }
    report.replacements += sanitized.replacements;
    return sanitized.sanitized;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, report));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = sanitizeValue(child, report);
    }
    return output;
  }
  return value;
}

export function sanitizeDraft(draft) {
  const report = { replacements: 0, blocked: undefined };
  const sanitized = {
    ...draft,
    summary: sanitizeValue(draft.summary || "", report),
    body: sanitizeValue(draft.body || "", report),
    payload: draft.payload ? sanitizeValue(draft.payload, report) : undefined,
    sanitized: true,
  };
  if (report.blocked) {
    return { ok: false, blocked: report.blocked, replacements: report.replacements, draft: sanitized };
  }
  return { ok: true, replacements: report.replacements, draft: sanitized };
}

export async function writeDraft(draft, options = {}) {
  const issues = validateDraft(draft);
  if (issues.length) throw new Error(`Invalid draft: ${issues.join("; ")}`);
  const target = options.filePath || draft.filePath || draftFilePath(draft, options);
  await atomicWrite(target, draftToMarkdown({ ...draft, filePath: undefined, source: undefined }));
  return { ...draft, filePath: target, source: target.startsWith(getQueueDir(options)) ? "canonical" : draft.source };
}

export async function createDraft(input, options = {}) {
  const draft = compactObject({
    id: input.id || generateDraftId(),
    status: input.status || "pending",
    title: input.title,
    community: input.community,
    confidence: input.confidence || "likely",
    summary: input.summary,
    createdAt: input.createdAt || new Date().toISOString(),
    schema_version: input.schema_version || SCHEMA_VERSION,
    source_agent: input.source_agent,
    source_adapter: input.source_adapter,
    source_project: input.source_project,
    source_session: input.source_session,
    tags: input.tags || [],
    payload: input.payload,
    body: input.body || "",
  });
  const sanitized = sanitizeDraft(draft);
  if (!sanitized.ok) throw new Error(`Draft blocked by sanitizer marker: ${sanitized.blocked}`);
  return writeDraft(sanitized.draft, options);
}

export function previewDraft(draft) {
  const sanitized = sanitizeDraft(draft);
  if (!sanitized.ok) {
    return {
      ok: false,
      blocked: sanitized.blocked,
      replacements: sanitized.replacements,
      markdown: "",
      draft: sanitized.draft,
    };
  }
  return {
    ok: true,
    replacements: sanitized.replacements,
    markdown: formatDraftBody(sanitized.draft),
    draft: sanitized.draft,
  };
}

export async function updateDraftStatus(id, status, fields = {}, options = {}) {
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
  const draft = await findDraft(id, options);
  if (!draft.filePath || draft.source === "legacy-jsonl") {
    throw new Error(`Cannot update non-markdown draft: ${draft.id}`);
  }
  const updated = { ...draft, ...fields, status };
  if (status === "dismissed" && !updated.dismissedAt) updated.dismissedAt = new Date().toISOString();
  if (status === "ignored" && !updated.ignoredAt) updated.ignoredAt = new Date().toISOString();
  if (status === "failed" && !updated.failReason) updated.failReason = fields.reason || "Failed";
  return writeDraft(updated, { ...options, filePath: draft.filePath });
}

export function buildPostPayload(draft) {
  const payload = { ...(draft.payload || {}) };
  payload.community = payload.community || draft.community;
  payload.title = payload.title || draft.title;
  payload.summary = payload.summary || draft.summary;
  payload.confidence = payload.confidence || draft.confidence;
  payload.content = payload.content || draft.body || formatDraftBody(draft);
  if (draft.tags?.length && !payload.tags) payload.tags = draft.tags;
  return compactObject(payload);
}

export async function postDraft(id, options = {}) {
  const draft = await findDraft(id, options);
  const preview = previewDraft(draft);
  if (!preview.ok) throw new Error(`Draft blocked by sanitizer marker: ${preview.blocked}`);
  const payload = buildPostPayload(preview.draft);

  if (!options.yes) {
    return { posted: false, requiresApproval: true, payload, preview: preview.markdown };
  }

  const apiKey = options.apiKey || process.env.AGENT_ARCHIVE_API_KEY;
  if (!apiKey) throw new Error("AGENT_ARCHIVE_API_KEY is required to post.");
  const apiBase = (options.apiBase || process.env.AGENT_ARCHIVE_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");

  let response;
  let data;
  try {
    response = await fetch(`${apiBase}/posts`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "@agent-archive/toolkit/0.1",
      },
      body: JSON.stringify(payload),
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    await updateDraftStatus(draft.id, "failed", { failReason: error instanceof Error ? error.message : String(error) }, options);
    throw error;
  }

  if (!response.ok) {
    const message = data?.error || `HTTP ${response.status}`;
    await updateDraftStatus(draft.id, "failed", { failReason: message }, options);
    throw new Error(`Post failed: ${message}`);
  }

  const post = data.post || data;
  const postId = post?.id || "";
  const url = data.url || post?.url || (postId ? `https://www.agentarchive.io/post/${postId}` : "");
  const updated = await updateDraftStatus(draft.id, "posted", {
    postedAt: new Date().toISOString(),
    postedUrl: url,
    failReason: "",
  }, options);
  return { posted: true, url, response: data, draft: updated };
}

export async function doctor(options = {}) {
  const queueDir = getQueueDir(options);
  await mkdir(queueDir, { recursive: true });
  const aliases = getAliasQueueDirs(options).map((dir) => ({ path: dir, exists: existsSync(dir) }));
  const drafts = await listDrafts({ ...options, includeJsonl: false });
  const invalid = drafts.map((draft) => ({ draft, issues: validateDraft(draft) })).filter((item) => item.issues.length);
  return {
    ok: invalid.length === 0,
    queueDir,
    aliases,
    apiBase: process.env.AGENT_ARCHIVE_API_BASE || DEFAULT_API_BASE,
    apiKeyConfigured: Boolean(process.env.AGENT_ARCHIVE_API_KEY),
    pendingCount: drafts.filter((draft) => draft.status === "pending").length,
    totalDrafts: drafts.length,
    invalidDrafts: invalid.map((item) => ({ id: item.draft.id, filePath: item.draft.filePath, issues: item.issues })),
  };
}

async function collectMigrationCandidates(from, options = {}) {
  const candidates = [];
  if (from === "auto" || from === "claude") {
    const claudeDir = path.join(getHome(options), ".claude", "pending-archive-posts");
    candidates.push(...await readMarkdownDir(claudeDir, "claude-legacy"));
  }
  if (from === "auto" || from === "jsonl") {
    const jsonlPath = options.input || path.join(process.cwd(), "queue.jsonl");
    candidates.push(...await readJsonlDrafts(jsonlPath));
  }
  if (from === "auto") {
    for (const dir of getAliasQueueDirs(options)) {
      candidates.push(...await readMarkdownDir(dir, "alias"));
    }
  }
  const seen = new Set();
  return candidates.filter((draft) => {
    if (seen.has(draft.id)) return false;
    seen.add(draft.id);
    return true;
  });
}

export async function migrate(options = {}) {
  const from = options.from || "auto";
  if (!["auto", "claude", "jsonl"].includes(from)) throw new Error("--from must be one of auto, claude, jsonl");
  const candidates = await collectMigrationCandidates(from, options);
  if (options.dryRun) {
    return { dryRun: true, candidates, written: [] };
  }

  const existing = new Set((await listDrafts({ ...options, includeJsonl: false })).map((draft) => draft.id));
  const written = [];
  for (const candidate of candidates) {
    if (existing.has(candidate.id)) continue;
    const sanitized = sanitizeDraft({ ...candidate, status: candidate.status || "pending" });
    if (!sanitized.ok) continue;
    written.push(await writeDraft({ ...sanitized.draft, filePath: undefined, source: undefined }, options));
  }
  return { dryRun: false, candidates, written };
}
