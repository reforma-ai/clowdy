/*
 * Ported from Orca's rich-markdown-source-reconcile.ts (https://github.com/stablyai/orca),
 * without its line-ending handling.
 *
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { applyPatches, cleanupEfficiency, cleanupSemantic, makeDiff, makePatches, type Patch } from '@sanity/diff-match-patch';

/** Longer documents emit the editor's markdown: the reparse that proves a patch runs on every edit. */
export const RECONCILE_MAX_LENGTH = 50_000;

// Bounds replacement-heavy diffs; the reparse rejects a coarse result that misplaces text.
const DIFF_TIMEOUT_SECONDS = 0.01;

export interface ReconcileMarkdownParams {
    /** The markdown as the file writes it. */
    source: string;
    /** The editor's serialization of `source`. */
    baseCanonical: string;
    /** The editor's serialization after the edit. */
    edited: string;
    /** Serializes `markdown` as the editor would after parsing it; `null` when it can't. */
    roundTrip: (markdown: string) => string | null;
}

/**
 * `edited` in the style of `source`: the change from `baseCanonical` to `edited` patched into
 * `source`, so untouched blocks keep their markers and spacing. Returns `edited` when the patched
 * text doesn't parse back to the same document; the caller restores the final newline then.
 */
export function reconcileMarkdown({ source, baseCanonical, edited, roundTrip }: ReconcileMarkdownParams): string {
    if (edited === baseCanonical) {
        return source;
    }

    // Patch the source without the final newlines the editor's markdown lacks, so an edit at the end lands before them.
    const ending = '\n'.repeat(Math.max(0, finalNewlines(source) - finalNewlines(baseCanonical)));
    const text = source.slice(0, source.length - ending.length);

    // Canonical source takes the edit as is; more blank lines at its end only survive through the patch.
    if (ending.length <= 1 && text === baseCanonical) {
        return edited + ending;
    }

    if (Math.max(source.length, baseCanonical.length, edited.length) > RECONCILE_MAX_LENGTH) {
        return edited;
    }

    // Repeated half-match seeds make the diff ignore its deadline.
    if (hasRepeatedHalfMatchSeed(baseCanonical, edited)) {
        return edited;
    }

    let diffs = makeDiff(baseCanonical, edited, { checkLines: true, timeout: DIFF_TIMEOUT_SECONDS });

    // The cleanup makePatches runs on its own diff, which has a one-second deadline.
    if (diffs.length > 2) {
        diffs = cleanupEfficiency(cleanupSemantic(diffs));
    }

    const patches = makePatches(baseCanonical, diffs);

    toUtf8Offsets(patches, text);

    const [patched, applied] = applyPatches(patches, text);

    // A fuzzy placement counts only when the patched text parses back to the edited document.
    return applied.every(Boolean) && roundTrip(patched + ending) === edited ? patched + ending : edited;
}

function finalNewlines(markdown: string): number {
    return markdown.length - markdown.replace(/\n+$/, '').length;
}

/**
 * `applyPatches` reads patch starts as UTF-8 offsets into the text it patches; `makePatches`
 * writes UTF-16 indices. Measuring them in `text` keeps the indices where they were.
 */
function toUtf8Offsets(patches: Patch[], text: string): void {
    const offsets = new Map<number, number>();
    let index = 0;
    let offset = 0;

    for (const target of [...new Set(patches.flatMap(patch => [patch.start1, patch.start2]))].sort((a, b) => a - b)) {
        while (index < Math.min(target, text.length)) {
            const codePoint = text.codePointAt(index)!;

            offset += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
            index += codePoint > 0xffff ? 2 : 1;
        }

        offsets.set(target, offset);
    }

    for (const patch of patches) {
        patch.start1 = offsets.get(patch.start1)!;
        patch.start2 = offsets.get(patch.start2)!;
    }
}

function hasRepeatedHalfMatchSeed(textA: string, textB: string): boolean {
    // Trim the common prefix and suffix as the diff does, so a small edit isn't taken for a repetitive replacement.
    const minimumLength = Math.min(textA.length, textB.length);
    let prefixLength = 0;

    while (prefixLength < minimumLength && textA.charCodeAt(prefixLength) === textB.charCodeAt(prefixLength)) {
        prefixLength += 1;
    }

    let suffixLength = 0;

    while (
        suffixLength < minimumLength - prefixLength
        && textA.charCodeAt(textA.length - suffixLength - 1) === textB.charCodeAt(textB.length - suffixLength - 1)
    ) {
        suffixLength += 1;
    }

    const middleA = textA.slice(prefixLength, textA.length - suffixLength);
    const middleB = textB.slice(prefixLength, textB.length - suffixLength);
    const longText = middleA.length > middleB.length ? middleA : middleB;
    const shortText = middleA.length > middleB.length ? middleB : middleA;

    if (longText.length < 4 || shortText.length * 2 < longText.length) {
        return false;
    }

    const seedLength = Math.floor(longText.length / 4);

    for (const start of [Math.ceil(longText.length / 4), Math.ceil(longText.length / 2)]) {
        const seed = longText.slice(start, start + seedLength);
        const firstMatch = shortText.indexOf(seed);

        if (firstMatch !== -1 && shortText.includes(seed, firstMatch + 1)) {
            return true;
        }
    }

    return false;
}
