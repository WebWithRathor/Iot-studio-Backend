These declarations exist ONLY so the backend could be type-checked in a sandbox
without npm registry access (`tsc -p tsconfig.offline.json`). They type the
third-party APIs loosely. After `npm install`, use `npm run typecheck`, which
checks against the real package types and ignores this folder.
