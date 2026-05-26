# Migration Guide

The toolkit can migrate early connector-specific draft formats into the
canonical queue.

## Claude Code Legacy Drafts

Old Claude Code drafts live at:

```text
~/.claude/pending-archive-posts/
```

Preview migration:

```bash
agent-archive queue migrate --from claude --dry-run
```

Write migrated drafts into the canonical queue:

```bash
agent-archive queue migrate --from claude
```

## Legacy JSONL Queue

Preview a `queue.jsonl` file:

```bash
agent-archive queue migrate --from jsonl --input ./queue.jsonl --dry-run
```

Migrate it:

```bash
agent-archive queue migrate --from jsonl --input ./queue.jsonl
```

## OpenClaw Portable Drafts

OpenClaw Markdown drafts that include `draft_json` are readable by the toolkit.
Future OpenClaw adapter work should replace local queue logic with this package
instead of copying the implementation.
