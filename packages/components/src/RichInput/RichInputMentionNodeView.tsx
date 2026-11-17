'use client';

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { use, type MouseEvent, type PointerEvent, type ReactNode } from 'react';

import { defaultRenderMention, mentionAttrsFromNode, RichInputMentionContext } from './mentionRender';

/** TipTap host for consumer mention UI (via {@link RichInputMentionContext}). */
export function RichInputMentionNodeView({ node, deleteNode }: NodeViewProps): ReactNode {
    const RenderMention = use(RichInputMentionContext) ?? defaultRenderMention;
    const mention = mentionAttrsFromNode(node.attrs);

    return (
        <NodeViewWrapper
            as="span"
            contentEditable={ false }
            onPointerDown={ (event: PointerEvent) => event.stopPropagation() }
            onClick={ (event: MouseEvent) => event.stopPropagation() }
        >
            <RenderMention mention={ mention } deleteNode={ deleteNode } />
        </NodeViewWrapper>
    );
}
