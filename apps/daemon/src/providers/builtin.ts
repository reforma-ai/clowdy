import { claude } from './claude';
import { codex } from './codex';
import { copilot } from './copilot';
import { cursor } from './cursor';
import { gemini } from './gemini';
import { grok } from './grok';
import { hermes } from './hermes';
import { omp } from './omp';
import { opencode } from './opencode';

import type { Provider } from './types';

/**
 * The agents Clowdy knows how to start. Most run their own program in ACP mode; Claude Code and Codex have no ACP mode of
 * their own and run through the official adapters, pinned in their own modules (read the adapter's changelog before bumping it). Pin a
 * version at least three days old: on a machine whose global `~/.bunfig.toml` sets `minimumReleaseAge`, `bun x` refuses
 * anything newer when its cache lacks that exact version ("No version matching ... blocked by minimum-release-age"), which
 * ends the run before the agent starts, in any folder (measured with Bun 1.4.4: `bun x` does not read the `bunfig.toml` of
 * the folder the run works in). `npm view <package> time` shows when each version was published.
 */
export const PROVIDERS: readonly Provider[] = [claude, codex, cursor, opencode, gemini, copilot, grok, omp, hermes];
