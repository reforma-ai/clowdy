import { mergeRefs } from '@clowdy/lib';
import { useMemo } from 'react';

import type { Ref } from 'react';

/**
 * One callback ref that feeds both refs, with an identity that holds while the refs do, so React
 * does not detach and reattach the node on every render.
 *
 * `mergeRefs` only writes the refs when React attaches the node, never during render. The React
 * Compiler lint cannot see that for a function, but it lets a ref go into a hook.
 */
export function useMergedRef<T>(first: Ref<T> | undefined, second: Ref<T> | undefined): Ref<T> {
    return useMemo(() => mergeRefs(first, second), [first, second]);
}
