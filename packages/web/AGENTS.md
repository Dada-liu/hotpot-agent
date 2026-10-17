# Working in packages/web/

- Source in `src/`, tests in `test/*.test.ts`. `src/main.tsx` is the vite entry, `src/App.tsx` is the root component. `src/protocol.ts` mirrors the server-side wire contract (`packages/server/src/wire.ts`) — keep both sides in sync on any change.
- This package must never depend on `@hotpot/core` or other node packages at runtime: vite only bundles browser-safe code. Structural typing in `protocol.ts` mirrors the needed field subsets instead of importing them.
- State is a pure fold: `src/state/reducer.ts` reduces `WireEvent`s into `ChatState`; components render projections of that state. Keep the reducer free of DOM and React imports so it stays unit-testable in node.
- LLM-facing prompt text is English; code comments in Simplified Chinese.
- Erasable TypeScript only, `.ts`/`.tsx` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test`, `pnpm typecheck`, and `pnpm exec biome check` from the repo root before committing.
