// Adapted from Reforma's provider-error-message.ts (apps/sandbox/src/chat/agent/helpers): readable text out of nested
// errors and wire bodies. Shared by the Claude engine's and the ACP engine's failure classifiers.

const MAX_DEPTH = 4;

/** Replaces a JSON error body inside `text` (`API Error: 529 {"error":{"message":"Overloaded"}}`) with its message. */
function unwrapBody(text: string, depth: number): string {
    const start = text.indexOf('{');

    if (start < 0 || depth > MAX_DEPTH) {
        return text.trim();
    }

    try {
        const body = JSON.parse(text.slice(start)) as { error?: { message?: unknown }; message?: unknown };
        const inner = body.error?.message ?? body.message;

        if (typeof inner === 'string' && inner.trim()) {
            return [text.slice(0, start).trim(), unwrapBody(inner, depth + 1)].filter(Boolean).join(' ');
        }
    }
    catch {
        // Not JSON after all: keep the prose.
    }

    return text.trim();
}

/** The text a person should read from a thrown error, an API error body or a nested `cause` chain. */
export function readableMessage(error: unknown, depth = 0): string {
    if (depth > MAX_DEPTH || error == null) {
        return '';
    }

    if (typeof error === 'string') {
        return unwrapBody(error, 0);
    }

    if (typeof error !== 'object') {
        return String(error);
    }

    const record = error as { message?: unknown; error?: unknown; cause?: unknown; data?: unknown };
    const data = typeof record.data === 'string' ? record.data : (record.data as { details?: unknown; message?: unknown } | undefined)?.details ?? (record.data as { message?: unknown } | undefined)?.message;
    const own = typeof record.message === 'string' && record.message.trim() ? unwrapBody(record.message, 0) : '';
    const detail = typeof data === 'string' && data.trim() && !own.includes(data.trim()) ? unwrapBody(data, 0) : '';

    if (own || detail) {
        return [own, detail].filter(Boolean).join(': ');
    }

    return readableMessage(record.error, depth + 1) || readableMessage(record.cause, depth + 1);
}
