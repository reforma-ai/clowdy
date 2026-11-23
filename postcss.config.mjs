import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import cssDeclarationSorter from 'css-declaration-sorter';
import postcss from 'postcss';
import postcssPresetEnv from 'postcss-preset-env';

const require = createRequire(import.meta.url);

function normalizeKey(raw) {
    return raw.replace(/^(::|--|\.|:|#)/, '');
}

function hashNodes(nodes) {
    const parts = [];

    for (const n of nodes) {
        if (n.type === 'decl') {
            parts.push(`d:${n.prop.trim()}:${String(n.value).trim()}`);
        } else if (n.type === 'atrule') {
            parts.push(`a:${n.name}:${(n.params ?? '').trim()}`);
        } else if (n.type === 'rule') {
            parts.push(`r:${(n.selector ?? '').trim()}`);
        } else {
            parts.push(`t:${n.type}`);
        }
    }

    return parts.sort().join('|');
}

function resolveRef(fromFile, spec) {
    const basedir = fromFile ? path.dirname(fromFile) : process.cwd();

    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('..')) {
        return path.resolve(basedir, spec);
    }

    try {
        return require.resolve(spec, { paths: [basedir] });
    } catch {
        throw new Error(`Cannot resolve @reference "${spec}" from "${basedir}"`);
    }
}

function extractRulesetsFromRoot(root) {
    const out = new Map();

    root.walkAtRules('layer', at => {
        const name = (at.params ?? '').trim();

        if (name !== 'rulesets') {
            return;
        }

        for (const node of at.nodes ?? []) {
            if (node.type !== 'rule') {
                continue;
            }

            const key = normalizeKey(node.selector.trim());
            const body = node.nodes ? node.nodes.map(n => n.clone()) : [];

            if (out.has(key)) {
                const prev = out.get(key);

                if (hashNodes(prev) !== hashNodes(body)) {
                    throw at.error(`Duplicate ruleset key "${key}" inside referenced rulesets layer "rulesets"`);
                }
            } else {
                out.set(key, body);
            }
        }
    });

    return out;
}

function loadRulesetsFromFile(resolvedFile, visitedFiles = new Set()) {
    if (visitedFiles.has(resolvedFile) || !fs.existsSync(resolvedFile)) {
        return new Map();
    }

    visitedFiles.add(resolvedFile);

    const cssText = fs.readFileSync(resolvedFile, 'utf8');
    const root = postcss.parse(cssText, { from: resolvedFile });
    const rulesets = extractRulesetsFromRoot(root);

    const basedir = path.dirname(resolvedFile);

    root.walkAtRules('import', at => {
        const params = (at.params ?? '').trim();
        const match = params.match(/['"]([^'"]+)['"]|url\(['"]?([^'"]+)['"]?\)/);

        if (match) {
            const importPath = match[1] || match[2];

            if (importPath && !importPath.startsWith('http') && !importPath.startsWith('@')) {
                const resolvedImport = path.resolve(basedir, importPath);

                if (fs.existsSync(resolvedImport)) {
                    const importedRulesets = loadRulesetsFromFile(resolvedImport, new Set(visitedFiles));

                    for (const [key, body] of importedRulesets.entries()) {
                        if (!rulesets.has(key)) {
                            rulesets.set(key, body);
                        }
                    }
                }
            }
        }
    });

    return rulesets;
}

const referenceRulesetsPlugin = {
    postcssPlugin: 'postcss-reference-rulesets',

    async Once(root, { result }) {
        const fromFile = result.opts.from || result.root?.source?.input.from;
        const merged = new Map();

        const refs = [];

        root.walkAtRules('reference', at => {
            const raw = (at.params ?? '').trim();
            const spec = raw.replace(/^['"]|['"]$/g, '').trim();

            if (spec) {
                refs.push(spec);
            }

            at.remove();
        });

        for (const ref of refs) {
            const resolvedFile = resolveRef(fromFile, ref);

            result.messages.push({
                type: 'dependency',
                file: resolvedFile,
                plugin: referenceRulesetsPlugin.postcssPlugin,
            });

            const rulesets = loadRulesetsFromFile(resolvedFile);

            for (const [key, body] of rulesets.entries()) {
                if (merged.has(key)) {
                    const prev = merged.get(key);

                    if (hashNodes(prev) !== hashNodes(body)) {
                        throw root.error(`Ruleset collision for "${key}" from "${ref}"`);
                    }
                } else {
                    merged.set(key, body);
                }
            }
        }

        const importedRulesets = extractRulesetsFromRoot(root);

        for (const [key, body] of importedRulesets.entries()) {
            if (merged.has(key)) {
                const prev = merged.get(key);

                if (hashNodes(prev) !== hashNodes(body)) {
                    throw root.error(`Ruleset collision for "${key}" between @reference and @import`);
                }
            } else {
                merged.set(key, body);
            }
        }

        root.walkAtRules('layer', at => {
            const name = (at.params ?? '').trim();

            if (name !== 'rulesets') {
                return;
            }

            for (const node of at.nodes ?? []) {
                if (node.type !== 'rule') {
                    continue;
                }

                const key = normalizeKey(node.selector.trim());
                const body = node.nodes ? node.nodes.map(n => n.clone()) : [];

                if (merged.has(key)) {
                    const prev = merged.get(key);

                    if (hashNodes(prev) !== hashNodes(body)) {
                        throw at.error(`Duplicate ruleset key "${key}" inside referenced rulesets layer "rulesets"`);
                    }
                } else {
                    merged.set(key, body);
                }
            }
        });

        root.walkAtRules('ruleset', at => {
            const params = (at.params ?? '').trim();
            const rawKeys = params.split(/\s+/).filter(Boolean);

            if (rawKeys.length === 0) {
                at.remove();

                return;
            }

            const outNodes = [];

            for (const rawKey of rawKeys) {
                const key = normalizeKey(rawKey);

                const nodes = merged.get(key);

                if (!nodes) {
                    throw at.error(
                        `Unknown ruleset "${key}". Add @reference '@clowdy/styles/rulesets' (or correct key).`
                    );
                }

                outNodes.push(...nodes.map(n => n.clone()));
            }

            if (outNodes.length > 0) {
                at.replaceWith(outNodes);
            } else {
                at.remove();
            }
        });
    },
};

export default {
    plugins: [
        referenceRulesetsPlugin,
        postcssPresetEnv({
            stage: false,
            features: {
                'custom-media-queries': true,
                'nesting-rules': true,
            },
        }),
        cssDeclarationSorter({
            order: 'concentric-css',
        }),
    ],
};
