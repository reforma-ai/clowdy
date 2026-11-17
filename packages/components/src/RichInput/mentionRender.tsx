'use client';

import { createContext, type ReactNode } from 'react';

import type {
    ComposerMentionAttrs,
    ComposerMentionKind,
    RichInputMentionRenderer,
    RichInputMentionRenderProps,
} from './types';

export function mentionAttrsFromNode(attrs: Record<string, unknown> | undefined | null): ComposerMentionAttrs {
    const id = String(attrs?.id ?? '');
    const label = String(attrs?.label ?? id);
    const data = attrs?.data;

    return {
        id,
        label,
        kind: (attrs?.kind as ComposerMentionKind | undefined) ?? 'file',
        trigger: typeof attrs?.mentionSuggestionChar === 'string' ? attrs.mentionSuggestionChar : '@',
        ...(data != null ? { data } : {}),
    };
}

export const RichInputMentionContext = createContext<RichInputMentionRenderer | null>(null);

/** Plain-text fallback when the host omits {@link RichInputProps.renderMention}. */
export function defaultRenderMention({ mention }: RichInputMentionRenderProps): ReactNode {
    return mention.label;
}

/** Default copy/prompt text: omit the atom (context lives in attrs). */
export function defaultSerializeMention(_mention: ComposerMentionAttrs): string {
    return '';
}
