import { execFileSync } from "node:child_process";
import { ROOT } from "./load.mjs";

/**
 * Data files added or modified since `base` (e.g. "origin/main"), as repo-relative paths.
 * @param {string} base
 */
export function changedDataFiles(base) {
    if (!/^[\w./-]+$/.test(base)) throw new Error(`Invalid git ref: ${base}`);
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=AMR", `${base}...HEAD`, "--", "data"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
}
