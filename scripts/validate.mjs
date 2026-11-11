#!/usr/bin/env node
/**
 * Offline catalog validation (no network). Exit code 1 on any problem.
 *
 *   npm run validate
 *
 * In GitHub Actions problems are also emitted as file annotations on the PR diff.
 */
import { loadData } from "./lib/load.mjs";
import { validate } from "./lib/validate.mjs";

const data = await loadData();
const { errors, entries } = validate(data);
const gha = !!process.env.GITHUB_ACTIONS;

if (errors.length) {
    const byPath = Map.groupBy ? Map.groupBy(errors, (e) => e.path) : errors.reduce((m, e) => m.set(e.path, [...(m.get(e.path) ?? []), e]), new Map());
    for (const [p, list] of byPath) {
        console.error(`\n${p}`);
        for (const e of list) {
            console.error(`  ✗ ${e.message}`);
            if (gha) console.log(`::error file=${p}::${e.message.replace(/\r?\n/g, " ")}`);
        }
    }
    console.error(`\n${errors.length} problem(s) in ${byPath.size} file(s).`);
    process.exit(1);
}

console.log(`✓ ${data.sourceList.length} sources, ${data.files.length} files, ${data.patterns.length} patterns → ${entries.length} entries. All valid.`);
