/**
 * Pattern expansion. A pattern is one definition that expands into many files
 * (the cartesian product of its `vars`), e.g. "every size of a speed-test file".
 * Used by validation, the link checker and the build so all three see the same list.
 */

const PLACEHOLDER = /\{(\w+)\.(\w+)\}/g;

/**
 * Replace `{var.field}` placeholders using one combination of pattern values.
 * @param {string} template
 * @param {Record<string, Record<string, string | number>>} combo
 */
export function fill(template, combo) {
    return template.replace(PLACEHOLDER, (whole, name, field) => {
        const value = combo[name]?.[field];
        if (value === undefined) throw new Error(`Unknown placeholder ${whole}`);
        return String(value);
    });
}

/** @param {string} s */
const numeric = (s) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s);

/**
 * Cartesian product of the pattern's variables.
 * @param {Record<string, Record<string, string | number>[]>} vars
 */
export function combinations(vars) {
    /** @type {Record<string, Record<string, string | number>>[]} */
    let out = [{}];
    for (const [name, values] of Object.entries(vars)) {
        out = out.flatMap((combo) => values.map((v) => ({ ...combo, [name]: v })));
    }
    return out;
}

/** Hard cap so a typo in `vars` can't expand into millions of entries. */
export const MAX_EXPANSION = 500;

/**
 * Expand one pattern into concrete file entries (each remembers its pattern and source path).
 * @param {any} p
 */
export function expandPattern(p) {
    const { id, idTemplate, vars, size, meta, tags, exclude, $schema, _path, ...rest } = p;
    const combos = combinations(vars);
    if (combos.length > MAX_EXPANSION) throw new Error(`expands to ${combos.length} files (max ${MAX_EXPANSION})`);
    const skip = (combo) => (exclude ?? []).some((ex) => Object.entries(ex).every(([name, key]) => combo[name]?.key === key));
    return combos.filter((combo) => !skip(combo)).map((combo) => {
        const f = (s) => fill(s, combo);
        const resolvedSize = size === null || size === undefined ? null : Number(typeof size === "string" ? f(size) : size);
        return {
            ...rest,
            // Ids are lowercase-kebab everywhere, even when a var key is "10GB".
            id: f(idTemplate).toLowerCase(),
            name: f(rest.name),
            url: f(rest.url),
            format: f(rest.format),
            ...(rest.description ? { description: f(rest.description) } : {}),
            size: Number.isFinite(resolvedSize) ? resolvedSize : null,
            ...(meta ? { meta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, typeof v === "string" ? numeric(f(v)) : v])) } : {}),
            ...(tags ? { tags: tags.map(f) } : {}),
            patternId: id,
            _path,
        };
    });
}

/**
 * Every concrete file: single entries first, then expanded patterns. Each keeps `_path`
 * (the data file it came from) for error messages; strip it before publishing.
 * @param {{ files: any[], patterns: any[] }} data
 */
export function expandAll({ files, patterns }) {
    return [...files.map(({ $schema, ...f }) => f), ...patterns.flatMap(expandPattern)];
}
