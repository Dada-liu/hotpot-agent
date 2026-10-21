# Working in src/prompts/

- All prompt text is LLM-facing and must be English; code comments stay Simplified Chinese.
- Assemble role prompts locally and pass the section list to `buildSystemPrompt`. Never mutate the global section registry (`registerSection`/`resetSections`) from this module.
- Section orders: skills 1400, todos 1500, role instruction between rules (2000) and env (3000). Empty dynamic lists produce no section.
- Keep role responsibilities aligned with `docs/archive/03-agent-orchestration.md`: main silently assesses difficulty in the first turn (trivial answers directly, simple calls spawn_workers with one worker, complex outputs the plan in `PLAN_FORMAT_TEMPLATE` format), worker splits in parallel and summarizes, task summarizes.
- Plan and execution phases override the role instruction via `PLANNING_INSTRUCTIONS` / `EXECUTION_INSTRUCTIONS`; keep those constants English.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
