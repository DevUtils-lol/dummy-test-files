#!/usr/bin/env node
/**
 * Adds a file to the catalog: probes the link, fills in format and real size, writes
 * data/files/<category>/<id>.json and validates the result.
 *
 *   npm run add -- <url> --category video --source w3c [--name "Sintel trailer"] [--id ...] [--tags h264,trailer] [--format mp4]
 */
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA, loadData, rel } from "./lib/load.mjs";
import { probe } from "./lib/probe.mjs";
import { CATEGORIES, LIMITS } from "./lib/spec.mjs";
import { urlKey, validate } from "./lib/validate.mjs";
import { expandAll } from "./lib/expand.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};
const url = argv.find((a, i) => /^https?:\/\//.test(a) && !argv[i - 1]?.startsWith("--"));
const fail = (msg) => {
    console.error(`✗ ${msg}`);
    process.exit(1);
};

if (!url) fail('Usage: npm run add -- <url> --category <category> --source <source-id> [--name "…"] [--tags a,b]');
const category = flag("category");
if (!CATEGORIES.includes(category)) fail(`--category must be one of: ${CATEGORIES.join(", ")}`);

const data = await loadData();
const source = flag("source");
if (!data.sources[source]) {
    fail(`--source "${source ?? ""}" doesn't exist. Existing: ${Object.keys(data.sources).join(", ")}\n  New host? Create data/sources/<id>.json first (see CONTRIBUTING.md).`);
}
const existing = expandAll(data).find((f) => urlKey(f.url) === urlKey(url));
if (existing) fail(`This URL is already in the catalog as "${existing.id}" (${existing._path}).`);

const u = new URL(url);
const last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
const format = (flag("format") ?? last.match(/\.([a-z0-9]{1,10})$/i)?.[1] ?? "").toLowerCase();
if (!new RegExp(LIMITS.formatPattern).test(format)) fail(`Couldn't tell the format from the URL — pass --format <ext>`);

const slug = (s) => s.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const id = flag("id") ?? `${category}-${slug(last) || slug(u.hostname)}-${format}`.slice(0, LIMITS.idMax).replace(/-$/, "");
const target = path.join(DATA, "files", category, `${id}.json`);
if (await access(target).then(() => true, () => false)) fail(`${rel(target)} already exists — pass a different --id`);

console.log(`Probing ${url} …`);
const r = await probe({ url, format, size: null }, { method: data.sources[source].check ?? "range" });
if (!r.ok) fail(`The link doesn't work: ${r.error}`);
if (r.finalUrl && r.finalUrl !== url) console.warn(`! It redirects to ${r.finalUrl} — prefer the final URL if it is permanent.`);

const name = flag("name") ?? last.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim().slice(0, LIMITS.nameMax) || id;
const tags = flag("tags")?.split(",").map((t) => t.trim()).filter(Boolean);
const entry = {
    $schema: "../../../schema/file.schema.json",
    id,
    name,
    category,
    format,
    url,
    size: r.size,
    source,
    ...(tags?.length ? { tags } : {}),
};
await writeFile(target, JSON.stringify(entry, null, 4) + "\n");

const { errors } = validate(await loadData());
const mine = errors.filter((e) => e.path === rel(target));
if (mine.length) {
    console.error(`Wrote ${rel(target)}, but it needs fixing:`);
    for (const e of mine) console.error(`  ✗ ${e.message}`);
    process.exit(1);
}
const mb = r.size ? `${(r.size / 1048576).toFixed(2)} MB` : "unknown size";
console.log(`✓ Wrote ${rel(target)} (${mb}, ${r.cors ? "CORS ok" : "no CORS"}, signature ${r.signature === null ? "n/a" : r.signature ? "ok" : "MISMATCH"})`);
console.log(`  Review the name/tags, add "meta" (width, height, duration, codec…) if you know it, then open a PR.`);
