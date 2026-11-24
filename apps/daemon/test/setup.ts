import { setDefaultTimeout } from 'bun:test';

// Some tests wait on timers and on one another for several seconds, and a small CI runner slows those waits: the default of 5 s ended them mid-wait
// (limits.test.ts, on a loaded machine). A test that really hangs fails after 20 s instead.
// Bun applies this only to the first test file of a run: `bun run test` passes the same limit as `--timeout` so every file gets it.
setDefaultTimeout(20_000);
