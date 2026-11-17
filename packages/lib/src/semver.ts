export type ParsedVersion = {
    major: number;
    minor: number;
    patch: number;
};

/** Parse Clowdy version ids: `1`, `1.1`, `1.1.1`. */
export function parseVersion(id: string): ParsedVersion | null {
    const trimmed = id.trim();

    if (!trimmed || !/^\d+(\.\d+){0,2}$/.test(trimmed)) {
        return null;
    }

    const [majorRaw, minorRaw, patchRaw] = trimmed.split('.');
    const major = Number(majorRaw);
    const minor = minorRaw != null ? Number(minorRaw) : 0;
    const patch = patchRaw != null ? Number(patchRaw) : 0;

    return { major, minor, patch };
}

/** True when `candidate` is later in project history than `current`. */
export function isVersionAheadOf(candidate: string, current: string | null | undefined): boolean {
    if (!current) {
        return false;
    }

    const ahead = parseVersion(candidate);
    const checkout = parseVersion(current);

    if (!ahead || !checkout) {
        return false;
    }

    return ahead.major > checkout.major
      || (ahead.major === checkout.major && ahead.minor > checkout.minor)
      || (ahead.major === checkout.major && ahead.minor === checkout.minor && ahead.patch > checkout.patch);
}
