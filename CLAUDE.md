# CLAUDE.md — Pelko API Codebase Guide

## What This Is
pelko-api is the backend for Pelko (pelko.ai). Handles auth, builder conversations,
session management, and hierarchical memory.

## Builder Pipeline (src/builder/pipeline.ts)
All builder requests flow through four interfaces:
1. **Context Assembler** — Builds prompt (App Brief + file index + relevant code + memory + recent messages)
2. **LLM Caller** — Calls Claude API
3. **Response Parser** — Extracts text, code (<pelko_code>), file requests (<pelko_request_files>)
4. **Memory Updater** — Updates App Brief, file index, hierarchical summaries, embeddings

## Variant System
Behavior driven by variants (builder_variants table). Inheritance supported.
Config frozen per session. A/B testing via weighted assignment.

## Memory Hierarchy
- Level 1 (Chunks): ~10 messages → 4-6 sentence detailed summary
- Level 2 (Sections): ~5 chunks → 4-6 sentence phase summary
- Level 3 (Eras): ~5 sections → 3-4 sentence key decisions summary
All embedded via Voyage AI (voyage-3-large), searchable via pgvector.

## Key Tables
builder_variants, builder_sessions, builder_messages, builder_app_briefs,
builder_summaries, builder_metrics, builder_usage,
builder_summary_samples, builder_retrieval_scores

## Observability
- Every Haiku call tracks its own cost in builder_usage with a distinct interactionType
  (builder, brief_update, file_index, summarization, retrieval_scoring, quality_sampling)
- Per-request metrics logged to builder_metrics (context size, token counts, retrieval counts)
- Every 50th chunk summary gets quality-scored in builder_summary_samples
- Every 50th request with retrieval gets relevance-scored in builder_retrieval_scores

## Patterns
- Thin frontend: sends { appId, message }. Backend manages everything.
- Fire-and-forget memory: response returns immediately; memory updates async.
- File requests: Claude asks for files via <pelko_request_files>, pipeline does follow-up call.
- Frozen sessions: variant config resolved once at session creation.

## When Modifying
- New interface: add function in interfaces/, add case to pipeline.ts dispatchers
- New variant: INSERT into builder_variants with parent_name and config_overrides
- System prompt: update variant's systemPrompt in DB, or modify src/prompts/builderSystem.ts

Keep this file updated when making structural changes.
