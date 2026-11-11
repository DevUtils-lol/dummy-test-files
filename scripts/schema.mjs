#!/usr/bin/env node
/**
 * Generates the JSON Schemas in /schema from scripts/lib/spec.mjs. Editors use them for
 * autocomplete and inline errors (every data file points at one via "$schema").
 *
 *   npm run schema            # regenerate
 *   npm run schema -- --check # CI: fail if the committed schemas are out of date
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./lib/load.mjs";
import { CATEGORIES, LIMITS, META_FIELDS, PREVIEW_KINDS } from "./lib/spec.mjs";

const BASE = "https://raw.githubusercontent.com/DevUtils-lol/test-files/main/schema";

const meta = (patternValues) => ({
    type: "object",
    description: "Technical details shown next to the file.",
    additionalProperties: false,
    properties: {
        codec: { type: "string", maxLength: 40, description: 'e.g. "H.264", "AV1", "Opus"' },
        ...Object.fromEntries(Object.entries(META_FIELDS).map(([k, r]) => [k, patternValues ? { type: ["number", "string"] } : { type: "number", minimum: r.min, maximum: r.max }])),
    },
});

const common = {
    $schema: { type: "string" },
    id: { type: "string", pattern: LIMITS.idPattern, maxLength: LIMITS.idMax, description: "Unique lowercase-kebab-case id. Must match the file name." },
    name: { type: "string", minLength: 1, maxLength: LIMITS.nameMax, description: "Short human name, e.g. \"Big Buck Bunny 1080p\"." },
    category: { enum: CATEGORIES, description: "Must match the folder the file is in." },
    source: { type: "string", pattern: LIMITS.idPattern, description: "Id of a file in data/sources/." },
    description: { type: "string", maxLength: LIMITS.descriptionMax },
    preview: { enum: PREVIEW_KINDS, description: "Override how apps preview it (derived from the format when omitted)." },
    approxSize: { type: "boolean", description: "The size is nominal (e.g. a \"10 MB\" file that is 10.4 MB)." },
};

const fileSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `${BASE}/file.schema.json`,
    title: "Test file",
    description: "One downloadable test file. Lives at data/files/<category>/<id>.json.",
    type: "object",
    additionalProperties: false,
    required: ["id", "name", "category", "format", "url", "size", "source"],
    properties: {
        ...common,
        format: { type: "string", pattern: LIMITS.formatPattern, description: "Lowercase extension without the dot, e.g. \"mp4\" or \"tar.gz\"." },
        url: { type: "string", format: "uri", pattern: "^https?://", maxLength: LIMITS.urlMax, description: "Direct, permanent, public download link (https)." },
        size: { type: ["integer", "null"], minimum: 1, maximum: LIMITS.sizeMax, description: "Size in bytes, or null if unknown (the checker measures it)." },
        tags: { type: "array", maxItems: LIMITS.tagsMax, uniqueItems: true, items: { type: "string", pattern: LIMITS.tagPattern, maxLength: LIMITS.tagMax } },
        meta: meta(false),
    },
};

const patternSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `${BASE}/pattern.schema.json`,
    title: "Test file pattern",
    description: "One definition that expands into many files (cartesian product of vars). String fields may use {var.field} placeholders. Lives at data/patterns/<category>/<id>.json.",
    type: "object",
    additionalProperties: false,
    required: ["id", "idTemplate", "name", "category", "format", "url", "size", "source", "vars"],
    properties: {
        ...common,
        idTemplate: { type: "string", description: "Id of each expanded file, e.g. \"any-cf-{size.key}\"." },
        format: { type: "string" },
        url: { type: "string", pattern: "^https?://" },
        size: { type: ["string", "integer", "null"], description: "Bytes, or a placeholder like \"{size.bytes}\"." },
        tags: { type: "array", maxItems: LIMITS.tagsMax, items: { type: "string" } },
        meta: meta(true),
        vars: {
            type: "object",
            minProperties: 1,
            additionalProperties: { type: "array", minItems: 1, items: { type: "object", required: ["key"], properties: { key: { type: "string" } }, additionalProperties: { type: ["string", "number"] } } },
        },
        exclude: { type: "array", items: { type: "object", additionalProperties: { type: "string" } }, description: "Combinations that don't exist upstream, matched on each var's key." },
    },
};

const sourceSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `${BASE}/source.schema.json`,
    title: "Source",
    description: "Who hosts the files and under which terms. Lives at data/sources/<id>.json.",
    type: "object",
    additionalProperties: false,
    required: ["id", "name", "homepage", "license"],
    properties: {
        $schema: { type: "string" },
        id: { type: "string", pattern: LIMITS.idPattern, maxLength: LIMITS.idMax },
        name: { type: "string", minLength: 1, maxLength: LIMITS.nameMax },
        homepage: { type: "string", pattern: "^https?://" },
        license: { type: "string", minLength: 1, maxLength: 200, description: "Terms under which the files may be used, e.g. \"CC-BY 4.0\"." },
        check: { enum: ["range", "head"], description: "\"head\" for hosts that ignore Range requests and are slow to stream." },
        allowHttp: { type: "boolean", description: "Accept plain http:// links from this host (maintainers only — e.g. legacy speed-test servers)." },
        notes: { type: "string", maxLength: 500 },
    },
};

const check = process.argv.includes("--check");
let stale = 0;
for (const [name, schema] of [["file", fileSchema], ["pattern", patternSchema], ["source", sourceSchema]]) {
    const file = path.join(ROOT, "schema", `${name}.schema.json`);
    const body = JSON.stringify(schema, null, 2) + "\n";
    if (check) {
        const existing = await readFile(file, "utf8").catch(() => "");
        if (existing !== body) {
            console.error(`✗ schema/${name}.schema.json is out of date — run "npm run schema"`);
            stale++;
        }
    } else {
        await writeFile(file, body);
    }
}
if (stale) process.exit(1);
console.log(check ? "✓ schemas up to date" : "✓ schemas written");
