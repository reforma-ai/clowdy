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

/** Bound the wait for the native prediction after an otherwise successful turn. */
export const SUGGESTION_WAIT_MS = 3000;
