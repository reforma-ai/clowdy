# @clowdy/eslint-config

Shared ESLint 9 flat config. `eslint` `^9` is a peer; plugins and the Babel parser ship with this package.

Formats JS/TS with `--fix`: indent 4, semicolons, single quotes, sorted imports (stylistic + perfectionist). CSS/LESS via Prettier. No type-aware typescript-eslint — TypeScript 7 has no JS API yet.

```sh
bun add -d eslint @clowdy/eslint-config
```

```js
import config, { combine } from "@clowdy/eslint-config/react";

export default combine(config, {
  rules: {
    "no-console": "warn",
  },
});
```

- `./react` — plus hooks / react-refresh for `jsx`/`tsx`
- `./base` — same rules as `.`
- `combine` — named export from `.`, `./base`, and `./react`
