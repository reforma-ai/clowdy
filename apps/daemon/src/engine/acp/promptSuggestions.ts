import type { LatePromptSuggestion } from '../types';

/** Accept the first non-empty plain-text prompt, without dropping resource links or other content. */
export function bestPromptSuggestion(value: unknown): string | undefined {
    if (!Array.isArray(value)) return undefined;
    for (const suggestion of value) {
        const prompt: unknown = suggestion?.prompt;
        if (
            !Array.isArray(prompt) ||
            !prompt.length ||
            !prompt.every(block => block?.type === 'text' && typeof block.text === 'string')
        ) {
            continue;
        }
        const text = prompt
            .map(block => block.text)
            .join('\n')
            .trim();
        if (text) return text;
    }
    return undefined;
}

/** How long a completed transport may remain open for an optional native prediction. */
export const SUGGESTION_WAIT_MS = 3000;

/** Receives updates on the wire, not from the turn iterator: the iterator may already have returned after done. */
export class PromptSuggestionWindow {
    private candidate?: string;
    private invalid = false;
    private complete = false;
    private resolve?: (text: string | undefined) => void;
    private timer?: ReturnType<typeof setTimeout>;
    late?: LatePromptSuggestion;

    observe(value: unknown): void {
        if (this.invalid) return;
        const text = bestPromptSuggestion(value);
        if (this.complete) {
            this.finish(text);
        } else {
            this.candidate = text;
        }
    }

    invalidate(): void {
        this.invalid = true;
        this.candidate = undefined;
        this.finish(undefined);
    }

    /** The final answer is already usable. A late prediction must not delay done or keep a run active. */
    completed(): { promptSuggestion?: string; latePromptSuggestion?: LatePromptSuggestion } {
        if (this.invalid || this.complete) return {};
        this.complete = true;
        if (this.candidate) return { promptSuggestion: this.candidate };

        const result = new Promise<string | undefined>(resolve => {
            this.resolve = resolve;
        });
        const window = this;
        this.late = {
            result,
            get valid() {
                return !window.invalid;
            },
            cancel: () => this.invalidate(),
            close: () => this.finish(undefined),
        };
        this.timer = setTimeout(() => this.finish(undefined), SUGGESTION_WAIT_MS);
        this.timer.unref();
        return { latePromptSuggestion: this.late };
    }

    private finish(text: string | undefined): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.resolve?.(text);
        this.resolve = undefined;
    }
}
