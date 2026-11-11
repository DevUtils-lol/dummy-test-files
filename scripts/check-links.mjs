#!/usr/bin/env node
/**
 * Link checker. Probes every link (patterns expanded) and writes health to
 * status/<category>.json (or $TEST_FILES_STATUS_DIR — the `link-status` branch in CI). Runs daily in GitHub Actions; contributors' PRs run it on
 * just the entries they touched.
 *
 *   npm run check                              # everything, writes status/
 *   npm run check -- --only video-             # ids starting with "video-"
 *   npm run check -- --changed origin/main     # only entries changed vs a git ref (PRs)
 *   npm run check -- --strict                  # exit 1 if any checked link is not ok
 *   npm run check -- --dry                     # print results, write nothing
 *
 * Options: --concurrency N (default 12; at most 2 per host), --timeout MS (default 20000),
 *          --dead-after N (default 3 consecutive failures before a link is hidden)
 *
 * A link fails on HTTP errors, timeouts, an HTML page where a file was expected, a wrong
 * file signature, or a size that drifted by more than 5 %. It is only marked dead after N
 * consecutive failures, so a host's bad day doesn't remove it. Rate-limited answers keep the
 * previous status: "slow down" is not "broken".
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expandAll } from "./lib/expand.mjs";
import { changedDataFiles } from "./lib/git.mjs";
import { STATUS_DIR, loadData, rel } from "./lib/load.mjs";
import { politePool, probe } from "./lib/probe.mjs";
import { validate } from "./lib/validate.mjs";

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return fallback;
    const v = process.argv[i + 1];
    return v && !v.startsWith("--") ? v : true;
}

const opts = {
    only: arg("only", ""),
    changed: arg("changed", ""),
    strict: arg("strict", false) === true,
    dry: arg("dry", false) === true,
    concurrency: Number(arg("concurrency", 12)),
    timeout: Number(arg("timeout", 20000)),
    deadAfter: Number(arg("dead-after", 3)),
};

const data = await loadData();
const { errors } = validate(data);
if (errors.length) {
    console.error(`Catalog has ${errors.length} validation problem(s) — run "npm run validate" first.`);
    process.exit(1);
}

let all = expandAll(data);
const partial = !!(opts.only || opts.changed);
if (opts.only) all = all.filter((f) => f.id.startsWith(opts.only));
if (opts.changed) {
    const changed = new Set(changedDataFiles(opts.changed));
    const changedSources = new Set(data.sourceList.filter((s) => changed.has(s._path)).map((s) => s.id));
    all = all.filter((f) => changed.has(f._path) || changedSources.has(f.source));
    if (!all.length) {
        console.log("No changed entries to check.");
        process.exit(0);
    }
}

// Previous health, per category file.
const previous = {};
const prevCheckedAt = {};
for (const cat of new Set(all.map((f) => f.category))) {
    try {
        const s = JSON.parse(await readFile(path.join(STATUS_DIR, `${cat}.json`), "utf8"));
        previous[cat] = s.entries;
        prevCheckedAt[cat] = s.checkedAt;
    } catch {
        previous[cat] = {};
    }
}

console.log(`Checking ${all.length} links (concurrency ${opts.concurrency})…`);
let done = 0;
const results = await politePool(
    all,
    opts.concurrency,
    async (f) => {
        const r = await probe(f, { method: data.sources[f.source]?.check ?? "range", timeout: opts.timeout });
        done++;
        if (process.stdout.isTTY) process.stdout.write(`\r${done}/${all.length}`);
        return { f, r };
    },
    (f) => new URL(f.url).host,
);
if (process.stdout.isTTY) process.stdout.write("\n");

const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();
const counts = { ok: 0, failing: 0, dead: 0, rateLimited: 0 };
const problems = [];
/** @type {Record<string, Record<string, any>>} */
const next = {};
for (const { f, r } of results) {
    const prev = previous[f.category]?.[f.id];
    const bucket = (next[f.category] ??= partial ? { ...previous[f.category] } : {});
    if (r.rateLimited) {
        counts.rateLimited++;
        if (prev) bucket[f.id] = prev;
        problems.push({ f, state: "rate-limited", error: r.error });
        continue;
    }
    const failCount = r.ok ? 0 : (prev?.failCount ?? 0) + 1;
    const state = r.ok ? "ok" : failCount >= opts.deadAfter ? "dead" : "failing";
    counts[state]++;
    bucket[f.id] = {
        state,
        http: r.http,
        size: r.size ?? prev?.size ?? null,
        contentType: r.contentType,
        cors: r.cors,
        lastOk: r.ok ? today : prev?.lastOk ?? null,
        failCount,
        ...(r.error ? { error: r.error } : {}),
    };
    if (!r.ok) {
        problems.push({ f, state, error: r.error });
        console.log(`  ${state === "dead" ? "✗ DEAD" : "! fail"}  ${f.id}  ${r.error}  (${f._path})`);
    }
}

console.log(`\nok ${counts.ok} · failing ${counts.failing} · dead ${counts.dead} · rate-limited (unchanged) ${counts.rateLimited}`);

if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### Link check`, ``, `✅ ok **${counts.ok}** · ⚠️ failing **${counts.failing}** · ❌ dead **${counts.dead}** · ⏳ rate-limited **${counts.rateLimited}**`, ``];
    if (problems.length) {
        lines.push(`| Entry | State | Problem | File |`, `|---|---|---|---|`);
        for (const p of problems.slice(0, 200)) lines.push(`| \`${p.f.id}\` | ${p.state} | ${String(p.error).replace(/\|/g, "\\|")} | \`${p.f._path}\` |`);
    }
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}
if (process.env.GITHUB_ACTIONS) for (const p of problems) if (p.state !== "rate-limited") console.log(`::${opts.strict ? "error" : "warning"} file=${p.f._path}::${p.f.id}: ${p.error}`);

if (!opts.dry) {
    await mkdir(STATUS_DIR, { recursive: true });
    for (const [cat, entries] of Object.entries(next)) {
        const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
        const file = path.join(STATUS_DIR, `${cat}.json`);
        await writeFile(file, JSON.stringify({ checkedAt: partial ? prevCheckedAt[cat] ?? now : now, entries: sorted }, null, 2) + "\n");
    }
    console.log(`Wrote ${Object.keys(next).map((c) => rel(path.join(STATUS_DIR, `${c}.json`))).join(", ")}`);
}

if (opts.strict && counts.failing + counts.dead > 0) process.exit(1);
