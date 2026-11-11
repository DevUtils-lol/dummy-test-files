#!/usr/bin/env node
/**
 * Builds the published catalog that apps download.
 *
 *   npm run build                 # → dist/
 *   npm run build -- --out ../x   # another folder (CI builds into a checkout of the `dist` branch)
 *
 * Output (all paths relative to dist/v<FORMAT_VERSION>/):
 *
 *   index.json                      small, the ONLY file that changes on every update:
 *                                   build id, checkedAt, sources, per-category counts and shard list
 *   shards/<category>-<n>.<hash>.json
 *                                   the entries, split by category and at most BUILD.shardMax per
 *                                   shard. Content-addressed: a name never changes meaning, so
 *                                   clients and CDNs can cache shards forever and an update only
 *                                   downloads the shards that actually changed.
 *   all.json                        everything in one file, for simple consumers and offline snapshots
 *
 * Patterns are expanded and link health is merged in, so consumers never need any of this
 * repo's logic. Failing links are kept (never hidden) with `failingSince`, `lastOk` and `error`,
 * so apps can warn users instead of silently losing files. Output is deterministic: an unchanged catalog builds
 * byte-identical files, so CI only publishes real changes.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expandAll } from "./lib/expand.mjs";
import { ROOT, loadData, loadStatus } from "./lib/load.mjs";
import { BUILD, CATEGORIES, FORMAT_VERSION, previewOf } from "./lib/spec.mjs";
import { validate } from "./lib/validate.mjs";

const outIdx = process.argv.indexOf("--out");
const OUT = path.resolve(outIdx > 0 ? process.argv[outIdx + 1] : path.join(ROOT, "dist"));
const V = path.join(OUT, `v${FORMAT_VERSION}`);
const SHARDS = path.join(V, "shards");

const data = await loadData();
const { errors } = validate(data);
if (errors.length) {
    console.error(`Refusing to build: ${errors.length} validation problem(s). Run "npm run validate".`);
    process.exit(1);
}
const status = await loadStatus();

/** Key order is fixed so output is stable and diffs stay readable. */
function publish(f) {
    const s = status.entries[f.id];
    const measured = s?.size ?? null;
    const tags = f.tags?.map((t) => t.toLowerCase());
    return {
        id: f.id,
        name: f.name,
        category: f.category,
        format: f.format,
        url: f.url,
        size: measured ?? f.size,
        ...(f.approxSize && measured === null ? { approxSize: true } : {}),
        ...(f.meta && Object.keys(f.meta).length ? { meta: f.meta } : {}),
        source: f.source,
        ...(tags?.length ? { tags } : {}),
        ...(f.description ? { description: f.description } : {}),
        preview: f.preview ?? previewOf(f.format),
        cors: !!s?.cors,
        // "dead" is the old name for a long failure — published as failing, never dropped.
        health: !s ? "unchecked" : s.state === "ok" ? "ok" : "failing",
        // Only failing links carry dates, so healthy shards don't change every day.
        ...(s && s.state !== "ok"
            ? { ...(s.error ? { error: s.error } : {}), ...(s.failingSince ? { failingSince: s.failingSince } : {}), ...(s.lastOk ? { lastOk: s.lastOk } : {}) }
            : {}),
    };
}

const entries = expandAll(data)
    .map(publish)
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.id.localeCompare(b.id));

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const sources = Object.fromEntries(
    data.sourceList
        .filter((s) => entries.some((f) => f.source === s.id))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((s) => [s.id, { name: s.name, homepage: s.homepage, license: s.license }]),
);

await mkdir(SHARDS, { recursive: true });
const categories = [];
const current = new Set();
for (const cat of CATEGORIES) {
    const list = entries.filter((f) => f.category === cat);
    if (!list.length) continue;
    const shards = [];
    for (let i = 0, n = 0; i < list.length; i += BUILD.shardMax, n++) {
        const files = list.slice(i, i + BUILD.shardMax);
        const body = JSON.stringify({ format: FORMAT_VERSION, category: cat, files });
        const name = `${cat}-${n}.${hash(body)}.json`;
        await writeFile(path.join(SHARDS, name), body);
        current.add(name);
        shards.push({ path: `shards/${name}`, count: files.length, bytes: Buffer.byteLength(body) });
    }
    categories.push({ id: cat, count: list.length, shards });
}

const build = hash(JSON.stringify([...current].sort()) + (status.checkedAt ?? ""));
const index = { format: FORMAT_VERSION, build, checkedAt: status.checkedAt, total: entries.length, sources, categories };
await writeFile(path.join(V, "index.json"), JSON.stringify(index, null, 1) + "\n");
await writeFile(path.join(V, "all.json"), JSON.stringify({ format: FORMAT_VERSION, build, checkedAt: status.checkedAt, total: entries.length, sources, files: entries }));

// ---- retention: keep retired shards for a while so cached indexes never point at 404s ----
const RETENTION = path.join(V, "retention.json");
let retired = {};
try {
    retired = JSON.parse(await readFile(RETENTION, "utf8"));
} catch {
    /* first build */
}
const today = new Date().toISOString().slice(0, 10);
const cutoff = new Date(Date.now() - BUILD.retentionDays * 86_400_000).toISOString().slice(0, 10);
let removed = 0;
for (const name of await readdir(SHARDS)) {
    if (current.has(name)) {
        delete retired[name];
        continue;
    }
    retired[name] ??= today;
    if (retired[name] < cutoff) {
        await rm(path.join(SHARDS, name));
        delete retired[name];
        removed++;
    }
}
const onDisk = new Set(await readdir(SHARDS));
for (const name of Object.keys(retired)) if (!onDisk.has(name)) delete retired[name];
const sortedRetired = Object.fromEntries(Object.entries(retired).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(RETENTION, JSON.stringify(sortedRetired, null, 1) + "\n");

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const shardBytes = categories.flatMap((c) => c.shards).reduce((s, x) => s + x.bytes, 0);
console.log(`✓ build ${build}: ${entries.length} entries in ${current.size} shard(s) (${kb(shardBytes)} raw), ${Object.keys(sources).length} sources → ${path.relative(process.cwd(), V) || "."}`);
if (Object.keys(sortedRetired).length || removed) console.log(`  retention: ${Object.keys(sortedRetired).length} retired shard(s) kept, ${removed} removed`);
