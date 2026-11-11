#!/usr/bin/env node
/**
 * Commits a fresh build into a checkout of the `dist` branch so that index.json points at
 * an exact, immutable commit:
 *
 *   1. commit everything except index.json (new shards, all.json, retention) → commit A
 *   2. write A's id into index.json as "commit" (plus "publishedAt"), commit it → commit B
 *
 * Why: CDNs cache the mutable `@dist` branch for hours and different edge nodes disagree.
 * Apps read the tiny index.json from raw.githubusercontent.com (5-minute cache) and load
 * shards from jsDelivr pinned to `@<commit>`, which can never be stale. If nothing changed
 * (same shards, same index apart from "commit"), nothing is committed.
 *
 *   node scripts/publish-dist.mjs <dist-worktree> [--message "build abc1234"]
 *
 * Prints "changed=true|false" (for $GITHUB_OUTPUT). Does not push.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FORMAT_VERSION } from "./lib/spec.mjs";

const dir = path.resolve(process.argv[2] ?? "out");
const mi = process.argv.indexOf("--message");
const message = mi > 0 ? process.argv[mi + 1] : "build";
const INDEX = `v${FORMAT_VERSION}/index.json`;
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const quiet = (...args) => {
    try {
        execFileSync("git", args, { cwd: dir, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
};
const strip = (text) => {
    try {
        const { commit, publishedAt, ...rest } = JSON.parse(text);
        return JSON.stringify(rest);
    } catch {
        return null;
    }
};

const fresh = await readFile(path.join(dir, INDEX), "utf8");
const hasHead = quiet("rev-parse", "--verify", "HEAD");
const previous = hasHead ? (() => {
    try {
        return git("show", `HEAD:${INDEX}`);
    } catch {
        return "";
    }
})() : "";

// 1. Everything but the index.
git("add", "-A", "--", ".", `:(exclude)${INDEX}`);
const shardsChanged = !quiet("diff", "--cached", "--quiet");
if (shardsChanged) git("commit", "-q", "-m", `${message} (data)`);

// Nothing new at all (and the index is already pinned) → restore the committed index and stop.
const pinned = (() => {
    try {
        return /^[0-9a-f]{40}$/.test(JSON.parse(previous).commit);
    } catch {
        return false;
    }
})();
if (!shardsChanged && pinned && strip(previous) === strip(fresh)) {
    await writeFile(path.join(dir, INDEX), previous.endsWith("\n") ? previous : `${previous}\n`);
    console.log("Nothing changed.");
    console.log("changed=false");
    process.exit(0);
}

// 2. HEAD now contains every shard this index lists — pin to it.
const commit = git("rev-parse", "HEAD");
const index = JSON.parse(fresh);
// publishedAt lets apps tell which of two indexes is newer (never step back to a stale copy).
await writeFile(path.join(dir, INDEX), JSON.stringify({ ...index, commit, publishedAt: new Date().toISOString() }, null, 1) + "\n");
git("add", "--", INDEX);
git("commit", "-q", "-m", `${message} (index → ${commit.slice(0, 7)})`);
console.log(`Index pinned to ${commit.slice(0, 7)}.`);
console.log("changed=true");
