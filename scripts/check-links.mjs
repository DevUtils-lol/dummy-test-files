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
 *   npm run check -- --verbose                 # list every link (always on in GitHub Actions)
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

// ---- probe ------------------------------------------------------------------------------
const gha = !!process.env.GITHUB_ACTIONS;
const tty = !!process.stdout.isTTY;
const hostOf = (f) => new URL(f.url).host;
const hosts = new Set(all.map(hostOf));
const fmtTime = (ms) => {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
const fmtSize = (n) => (n == null ? "?" : n >= 1 << 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

console.log(`Checking ${all.length} links on ${hosts.size} hosts (concurrency ${opts.concurrency}, at most 2 per host, timeout ${opts.timeout / 1000}s)…`);
const started = Date.now();
const live = { ok: 0, bad: 0 };
let done = 0;
let lastReport = started;
const progress = () => {
    const elapsed = Date.now() - started;
    const left = done ? (elapsed / done) * (all.length - done) : 0;
    const pct = String(Math.floor((done / all.length) * 100)).padStart(3);
    return `[${String(done).padStart(String(all.length).length)}/${all.length}] ${pct}% · ok ${live.ok} · problems ${live.bad} · ${fmtTime(elapsed)} elapsed${done < all.length ? ` · ~${fmtTime(left)} left` : ""}`;
};
const results = await politePool(
    all,
    opts.concurrency,
    async (f) => {
        const t0 = Date.now();
        const r = await probe(f, { method: data.sources[f.source]?.check ?? "range", timeout: opts.timeout });
        const ms = Date.now() - t0;
        done++;
        live[r.ok ? "ok" : "bad"]++;
        if (tty) process.stdout.write(`\r${progress()}   `);
        // In CI logs: a progress line every 10 s or every 100 links, plus every problem as it happens.
        else if (Date.now() - lastReport >= 10_000 || done % 100 === 0 || done === all.length) {
            lastReport = Date.now();
            console.log(progress());
        }
        if (!r.ok && !tty) console.log(`  ! ${f.id}: ${r.error}`);
        return { f, r, ms };
    },
    hostOf,
);
if (tty) process.stdout.write("\n");
const duration = Date.now() - started;

// ---- results ------------------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();
const counts = { ok: 0, failing: 0, dead: 0, rateLimited: 0 };
const problems = [];
/** @type {Record<string, Record<string, any>>} */
const next = {};
/** Per-category rows for the detailed log. */
const rows = {};
for (const { f, r, ms } of results) {
    const prev = previous[f.category]?.[f.id];
    const bucket = (next[f.category] ??= partial ? { ...previous[f.category] } : {});
    (rows[f.category] ??= []).push({ f, r, ms });
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
    if (!r.ok) problems.push({ f, state, error: r.error, failCount });
}

// Every link, grouped by category. Collapsed groups in GitHub Actions; locally only with --verbose.
const verbose = gha || process.argv.includes("--verbose");
if (verbose) {
    console.log("");
    for (const [cat, list] of Object.entries(rows)) {
        const bad = list.filter((x) => !x.r.ok).length;
        const title = `${cat} — ${list.length} links · ${list.length - bad} ok${bad ? ` · ${bad} problem(s)` : ""}`;
        console.log(gha ? `::group::${title}` : `\n${title}`);
        for (const { f, r, ms } of list.sort((a, b) => a.f.id.localeCompare(b.f.id))) {
            const mark = r.ok ? "✓" : r.rateLimited ? "⏳" : "✗";
            const detail = r.ok ? `${r.http} · ${fmtSize(r.size)} · ${r.cors ? "CORS" : "no CORS"}${r.signature ? " · signature ok" : ""}` : r.error;
            console.log(`  ${mark} ${f.id.padEnd(48)} ${String(ms).padStart(6)} ms  ${detail}`);
        }
        if (gha) console.log("::endgroup::");
    }
}

// Hosts with problems, and the slowest hosts — useful when a whole server is down.
const byHost = new Map();
for (const { f, r, ms } of results) {
    const h = byHost.get(hostOf(f)) ?? { links: 0, bad: 0, ms: 0 };
    h.links++;
    h.ms += ms;
    if (!r.ok) h.bad++;
    byHost.set(hostOf(f), h);
}
const badHosts = [...byHost].filter(([, h]) => h.bad).sort((a, b) => b[1].bad - a[1].bad);
if (badHosts.length) {
    console.log(`\nHosts with problems:`);
    for (const [host, h] of badHosts) console.log(`  ${host.padEnd(40)} ${h.bad}/${h.links} failed`);
}
if (problems.length) {
    console.log(`\nProblems (${problems.length}):`);
    for (const p of problems) console.log(`  ${p.state === "dead" ? "✗ DEAD   " : p.state === "rate-limited" ? "⏳ limited" : `! fail ${p.failCount}/${opts.deadAfter}`}  ${p.f.id}  ${p.error}  (${p.f._path})`);
}

console.log(`\nChecked ${all.length} links on ${hosts.size} hosts in ${fmtTime(duration)}: ok ${counts.ok} · failing ${counts.failing} · dead ${counts.dead} · rate-limited (unchanged) ${counts.rateLimited}`);

if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### Link check`, ``, `**${all.length}** links on **${hosts.size}** hosts checked in **${fmtTime(duration)}**`, ``, `✅ ok **${counts.ok}** · ⚠️ failing **${counts.failing}** · ❌ dead **${counts.dead}** · ⏳ rate-limited **${counts.rateLimited}**`, ``];
    if (problems.length) {
        lines.push(`| Entry | State | Problem | File |`, `|---|---|---|---|`);
        for (const p of problems.slice(0, 200)) lines.push(`| \`${p.f.id}\` | ${p.state} | ${String(p.error).replace(/\|/g, "\\|")} | \`${p.f._path}\` |`);
    }
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}
if (gha) for (const p of problems) if (p.state !== "rate-limited") console.log(`::${opts.strict ? "error" : "warning"} file=${p.f._path}::${p.f.id}: ${p.error}`);

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
