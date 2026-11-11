import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSignature, previewOf } from "../scripts/lib/spec.mjs";
import { expandPattern, MAX_EXPANSION } from "../scripts/lib/expand.mjs";
import { urlKey, validate } from "../scripts/lib/validate.mjs";

const bytes = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const pad = (s) => bytes(s.padEnd(64, "\0"));

test("signatures: matching, mismatching and unknown formats", () => {
    assert.equal(matchesSignature("png", pad("\x89PNG\r\n\x1A\n")), true);
    assert.equal(matchesSignature("png", pad("<html>")), false);
    assert.equal(matchesSignature("mp4", pad("\0\0\0\x20ftypisom")), true);
    assert.equal(matchesSignature("webp", pad("RIFF\0\0\0\0WEBPVP8 ")), true);
    assert.equal(matchesSignature("wav", pad("RIFF\0\0\0\0WEBPVP8 ")), false);
    assert.equal(matchesSignature("mp3", pad("\xFF\xFB\x90\x00")), true, "MPEG frame sync");
    assert.equal(matchesSignature("mp3", pad("ID3\x04")), true);
    assert.equal(matchesSignature("tar.gz", pad("\x1F\x8B\x08")), true, "compound format uses the last extension");
    assert.equal(matchesSignature("csv", pad("a,b,c")), null, "text formats have no signature");
    assert.equal(matchesSignature("png", bytes("\x89P")), null, "too few bytes to tell");
});

test("previewOf falls back to none", () => {
    assert.equal(previewOf("MP4"), "video");
    assert.equal(previewOf("xyz"), "none");
});

test("pattern expansion: placeholders, numbers, excludes and the size cap", () => {
    const p = {
        id: "p", idTemplate: "x-{s.key}", name: "{s.label} file", category: "any-size", format: "bin", source: "src",
        url: "https://example.com/{s.key}.bin", size: "{s.bytes}", meta: { width: "{s.w}" }, tags: ["{s.label}"],
        vars: { s: [{ key: "a", label: "A", bytes: 10, w: 5 }, { key: "b", label: "B", bytes: 20, w: 6 }] },
        exclude: [{ s: "b" }],
    };
    const out = expandPattern(p);
    assert.equal(out.length, 1);
    assert.equal(expandPattern({ ...p, idTemplate: "x-{s.label}", exclude: undefined })[1].id, "x-b", "expanded ids are lowercased");
    assert.deepEqual({ id: out[0].id, size: out[0].size, meta: out[0].meta, tags: out[0].tags, patternId: out[0].patternId }, { id: "x-a", size: 10, meta: { width: 5 }, tags: ["A"], patternId: "p" });
    const big = { ...p, exclude: undefined, vars: { a: Array.from({ length: 30 }, (_, i) => ({ key: `${i}` })), b: Array.from({ length: 30 }, (_, i) => ({ key: `${i}` })) } };
    assert.throws(() => expandPattern(big), new RegExp(`max ${MAX_EXPANSION}`));
});

test("urlKey ignores host case and fragments", () => {
    assert.equal(urlKey("https://EXAMPLE.com/a.png#x"), urlKey("https://example.com/a.png"));
});

const source = { id: "src", name: "Src", homepage: "https://example.com", license: "CC0", _path: "data/sources/src.json" };
const file = (over = {}) => ({ id: "image-a-png", name: "A", category: "image", format: "png", url: "https://example.com/a.png", size: 100, source: "src", _path: "data/files/image/image-a-png.json", ...over });
const run = (files, extra = {}) => validate({ sources: { src: source, ...(extra.sources ?? {}) }, sourceList: [source, ...Object.values(extra.sources ?? {})], files, patterns: extra.patterns ?? [], parseErrors: [] }).errors.map((e) => e.message);

test("validation accepts a good entry", () => {
    assert.deepEqual(run([file()]), []);
});

test("validation rejects unsafe or broken entries", () => {
    const cases = {
        "plain http": file({ url: "http://example.com/a.png" }),
        "IP host": file({ url: "https://10.0.0.1/a.png" }),
        localhost: file({ url: "https://localhost/a.png" }),
        "file locker": file({ url: "https://drive.google.com/uc?id=1" }),
        shortener: file({ url: "https://bit.ly/abc" }),
        credentials: file({ url: "https://u:p@example.com/a.png" }),
        "signed URL": file({ url: "https://example.com/a.png?X-Amz-Signature=abc" }),
        "wrong folder": file({ _path: "data/files/video/image-a-png.json" }),
        "unknown field": file({ colour: "red" }),
        "bad id": file({ id: "Image A", _path: "data/files/image/Image A.json" }),
        "missing source": file({ source: "nope" }),
        "negative size": file({ size: -1 }),
        "bad meta": file({ meta: { width: "wide" } }),
    };
    for (const [label, entry] of Object.entries(cases)) assert.ok(run([entry]).length > 0, `${label} should be rejected`);
});

test("validation catches duplicate ids and URLs across files", () => {
    const a = file();
    const b = file({ id: "image-b-png", _path: "data/files/image/image-b-png.json" });
    assert.ok(run([a, b]).some((m) => m.includes("already in the catalog")));
});

test("http is allowed only for sources that opt in", () => {
    const legacy = { id: "legacy", name: "Legacy", homepage: "http://legacy.example", license: "Free", allowHttp: true, _path: "data/sources/legacy.json" };
    assert.deepEqual(run([file({ source: "legacy", url: "http://legacy.example/a.png" })], { sources: { legacy } }), []);
});
