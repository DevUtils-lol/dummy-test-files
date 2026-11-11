# Test Files

An open catalog of **test and sample files** for developers: videos in every codec, huge images, broken PDFs, 100 GB speed-test files, odd CSVs, fonts, 3D models and more.

- **Checked every day.** A bot probes each link, compares its size and checks its first bytes, so a `.png` really is a PNG. A link that stops working is never hidden: it is flagged as failing, with the date it started and the error, and the flag clears as soon as the host recovers.
- **Anyone can add files.** Each file is one small JSON file, so a PR is a couple of lines and never conflicts with anyone else's.
- **Nothing to host.** The catalog only links to files that publishers host themselves, so it can grow without storage or bandwidth limits.
- **Free to reuse.** The data is CC0. Use it in your app, test suite or CLI.

You can browse it at **[devutils.lol/tools/test-files](https://devutils.lol/tools/test-files)**.

## Using the catalog

Built files are published to the `dist` branch and served by jsDelivr:

| URL | What it is |
|---|---|
| `https://cdn.jsdelivr.net/gh/DevUtils-lol/dummy-test-files@dist/v1/index.json` | A small index: build id, last check time, sources, and per-category counts with shard paths |
| `…@dist/v1/shards/<category>-<n>.<hash>.json` | The entries for one category. The file name includes a hash of its contents, so it never changes and can be cached forever |
| `…@dist/v1/all.json` | Everything in one file, for scripts and offline snapshots |

To stay fast at any size, load `index.json` first, then fetch only the shards you need, resolved relative to the index URL. Cache them by name: an update only adds new shard names, so returning visitors download only what changed. Old shards stay published for 14 days, so an index cached by a browser or CDN never points at a missing file.

Each entry looks like this:

```json
{
  "id": "video-sintel-trailer-mp4",
  "name": "Sintel trailer",
  "category": "video",
  "format": "mp4",
  "url": "https://media.w3.org/2010/05/sintel/trailer.mp4",
  "size": 4372373,
  "meta": { "width": 854, "height": 480, "duration": 52, "codec": "H.264" },
  "source": "w3c",
  "tags": ["h264", "trailer"],
  "preview": "video",
  "cors": false,
  "health": "ok"
}
```

`health` is `ok`, `failing` or `unchecked` (newly added). Failing entries also carry `error` (why), `failingSince` (the day the current failures began) and `lastOk` (the last day it worked). Links are never dropped, so apps decide how to show them. `cors: true` means browsers can fetch the file directly. `size` is the size the checker measured, in bytes.

The `/v1/` path changes only for breaking format changes, and old versions keep being published while consumers move over.

## Adding files

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
npm run add -- https://example.org/sample.mp4 --category video --source example
npm run validate
```

Then open a PR. CI checks the format and probes your links, and a maintainer reviews and merges.

## How it works

```
data/sources/<id>.json               who hosts the files, under which license
data/files/<category>/<id>.json      one file per entry
data/patterns/<category>/<id>.json   one definition → many files (e.g. every size of a speed-test file)
(branch link-status) status/*.json   link health, written only by the daily check
schema/*.json                        JSON Schemas (generated from scripts/lib/spec.mjs)
scripts/                             validate · check-links · build · add (plain Node, no dependencies)
```

| Workflow | When | What |
|---|---|---|
| `validate.yml` | every PR | schema + rules + tests + build. Probes only the links the PR adds or changes. Read-only and fork-safe. |
| `publish.yml` | merge to main | builds and pushes to the `dist` branch, then clears the CDN cache for `index.json` / `all.json` |
| `check-links.yml` | daily 03:17 UTC | probes every link, saves results to the `link-status` branch, republishes |

The scripts need Node 20.10 or newer. There's no `npm install`: they have zero dependencies, which keeps the supply chain empty.

## Maintainer setup (one time)

Three branches, three jobs:

| Branch | Holds | Who writes |
|---|---|---|
| `main` | the catalog (`data/`), scripts, workflows | people, through reviewed PRs only |
| `link-status` | link health from the daily check | only the Actions bot |
| `dist` | the built catalog apps download | only the Actions bot |

In repo **Settings**:

1. **Actions → General**
   - Workflow permissions: **Read and write permissions** (the bot pushes `link-status` and `dist`).
   - "Approval for running fork pull request workflows": **Require approval for first-time contributors**.
2. **Rules → Rulesets → New branch ruleset**, named "main", enforcement Active, target: default branch.
   - ✅ Restrict deletions · ✅ Block force pushes
   - ✅ Require a pull request before merging → 1 approval, ✅ Require review from Code Owners, ✅ Dismiss stale approvals when new commits are pushed
   - ✅ Require status checks to pass → add **Schema, rules & tests** and **New & changed links work** (they appear after the first PR run)
   - Bypass list: **Repository admin**, so you can still push hotfixes yourself. Leave it empty to hold yourself to the same rule.
3. Add a second ruleset for `link-status` and `dist`: only ✅ Restrict deletions. Don't require PRs there, or the bot can't write.
4. **Code owners:** `.github/CODEOWNERS` lists who must approve. To share the work, create a team (Organization → Teams → New team "maintainers", add people, give it **Write** on this repo) and replace `@sunanda35` there with `@DevUtils-lol/maintainers`.
5. Run **Actions → Daily link check → Run workflow** once. It checks every link and republishes `dist` with fresh health.

## License

Code: [MIT](LICENSE). Catalog data (`data/`, the `link-status` branch and the published files): [CC0 1.0](LICENSE-DATA). The linked files themselves belong to their publishers. Each source states its license.
