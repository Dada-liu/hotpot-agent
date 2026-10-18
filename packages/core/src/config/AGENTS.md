# Working in src/config/

- Settings are two-layer: user-level `<home>/settings.json` is required and owns models/credentials; project-level `.hotpot/settings.json` is optional, found by walking up from `cwd`, and may only override whitelisted non-credential fields. Unknown fields are stripped.
- Resolve home through `resolveHome` from `../session/store.ts`. The order is fixed: explicit `home` argument > `HOTPOT_HOME` > `~/.hotpot`; never duplicate the rule.
- `apiKey` supports whole-string `$ENV` references, user level only. Credentials must never be read from project settings.
- Feature switches (`features.*`), `hooks`, `webSearch`, `mcpServers`, `skillsDirs` and `promptsDirs` are user-level only for security reasons. Read switches through `featureEnabled` (default on).
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
