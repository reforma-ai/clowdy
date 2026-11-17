/** Trimmed non-empty string message, if present. */
export function readErrorMessage(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const message = value.trim();

    return message || undefined;
}

/** Best-effort message from an thrown value; optional fallback when none is found. */
export function errorMessage(error: unknown, fallback?: string): string {
    const direct = readErrorMessage(error);

    if (direct) {
        return direct;
    }

    if (error instanceof Error) {
        const fromError = readErrorMessage(error.message);

        if (fromError) {
            return fromError;
        }
    }

    if (error != null && typeof error === 'object' && 'message' in error) {
        const fromRecord = readErrorMessage((error as { message?: unknown }).message);

        if (fromRecord) {
            return fromRecord;
        }
    }

    return fallback ?? 'Unknown error';
}

/** Message from the direct `Error.cause` link (one level — not a full chain walk). */
export function errorCauseMessage(error: unknown): string | undefined {
    if (error == null || typeof error !== 'object' || !('cause' in error)) {
        return undefined;
    }

    const { cause } = error as { cause?: unknown };

    if (cause instanceof Error) {
        return readErrorMessage(cause.message);
    }

    const fromString = readErrorMessage(cause);

    if (fromString) {
        return fromString;
    }

    if (cause != null && typeof cause === 'object' && 'message' in cause) {
        return readErrorMessage((cause as { message?: unknown }).message);
    }

    return undefined;
}
