/**
 * Reads the catalog from disk. One JSON file per source / file / pattern keeps PRs
 * tiny and conflict-free no matter how many people contribute at once.
 *
 *   data/sources/<source-id>.json
 *   data/files/<category>/<file-id>.json
 *   data/patterns/<category>/<pattern-id>.json
 *   status/<category>.json            (written only by the link checker)
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA = path.join(ROOT, "data");
export const STATUS_DIR = path.join(ROOT, "status");

/** Repo-relative POSIX path, for messages and git comparisons. */
export const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

async function jsonFiles(dir) {
    let names;
    try {
        names = await readdir(dir, { recursive: true });
    } catch (e) {
        if (e.code === "ENOENT") return [];
        throw e;
    }
    return names.filter((n) => n.endsWith(".json")).sort().map((n) => path.join(dir, n));
}

/**
 * @returns {Promise<{ sources: Record<string, any>, sourceList: any[], files: any[], patterns: any[], parseErrors: { path: string, message: string }[] }>}
 */
export async function loadData() {
    const parseErrors = [];
    const read = async (abs) => {
        const raw = await readFile(abs, "utf8");
        try {
            return { ...JSON.parse(raw), _path: rel(abs) };
        } catch (e) {
            parseErrors.push({ path: rel(abs), message: `Invalid JSON: ${e.message}` });
            return null;
        }
    };
    const [sourceList, files, patterns] = await Promise.all(
        ["sources", "files", "patterns"].map(async (kind) => (await Promise.all((await jsonFiles(path.join(DATA, kind))).map(read))).filter(Boolean)),
    );
    const sources = Object.fromEntries(sourceList.map((s) => [s.id, s]));
    return { sources, sourceList, files, patterns, parseErrors };
}

/** Link health for every id, merged from the per-category status files. */
export async function loadStatus() {
    /** @type {Record<string, any>} */
    const entries = {};
    let checkedAt = null;
    for (const abs of await jsonFiles(STATUS_DIR)) {
        const s = JSON.parse(await readFile(abs, "utf8"));
        Object.assign(entries, s.entries);
        if (s.checkedAt && (!checkedAt || s.checkedAt > checkedAt)) checkedAt = s.checkedAt;
    }
    return { checkedAt, entries };
}
