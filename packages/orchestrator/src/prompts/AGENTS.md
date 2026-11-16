# Working in src/prompts/

- All prompt text is LLM-facing and must be English; code comments stay Simplified Chinese.
- Assemble role prompts locally and pass the section list to `buildSystemPrompt`. Never mutate the global section registry (`registerSection`/`resetSections`) from this module.
- Section orders: skills 1400, todos 1500, memory 1600, code-search 1700 (only when the tool declaration is present), role instruction between rules (2000) and env (3000). Empty dynamic lists and empty memory summaries produce no section. Memory text must stay English apart from the stored user content, and must restrict writes to stable preferences/facts while forbidding secrets and temporary state. The code-search section explains semantic discovery, query-time incremental refresh and follow-up reads.
- Keep role responsibilities aligned with `docs/archive/03-agent-orchestration.md`: main silently assesses difficulty in the first turn (trivial answers directly, simple calls spawn_workers with one worker, complex outputs the plan in `PLAN_FORMAT_TEMPLATE` format), worker splits in parallel and summarizes, task summarizes.
- Plan and execution phases override the role instruction via `PLANNING_INSTRUCTIONS` / `EXECUTION_INSTRUCTIONS`; keep those constants English.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
