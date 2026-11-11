# Contributing

Thanks for helping! Every file you add saves someone from hunting for "a 4K HEVC sample" or "a 2 GB CSV" at 2 am.

## What belongs here

✅ **Accepted:**
- Direct download links that are **public, permanent and free to use for testing**
- Files that test something: codecs, resolutions, sizes, edge cases (EXIF rotation, malformed headers, huge row counts, unusual encodings)
- Hosts that are stable: project websites, standards bodies, CDNs, GitHub raw/releases, speed-test servers

❌ **Not accepted** (CI rejects most of these automatically):
- File lockers and link shorteners (Google Drive, Dropbox, Mega, bit.ly, …), signed or expiring URLs, links behind a login
- IP addresses, localhost, private hosts
- Anything without clear permission to use it, personal data, or copyrighted media you don't have rights to
- Harmful files. Harmless *security test files* (like EICAR) go in `security/` and need a maintainer's OK first

## Add a file in 3 steps

**1. Make sure the host has a source file.** Look in `data/sources/`. If yours isn't there, create `data/sources/<id>.json`:

```json
{
    "$schema": "../../schema/source.schema.json",
    "id": "blender",
    "name": "Blender Foundation",
    "homepage": "https://www.blender.org",
    "license": "CC-BY 3.0"
}
```

**2. Add the file.** The helper probes the link and fills in the format and exact size:

```bash
npm run add -- https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4 \
  --category video --source blender --name "Big Buck Bunny 1080p" --tags h264,1080p
```

You can also write `data/files/<category>/<id>.json` by hand. Your editor will autocomplete fields from the schema:

```json
{
    "$schema": "../../../schema/file.schema.json",
    "id": "video-bbb-1080p-mp4",
    "name": "Big Buck Bunny 1080p",
    "category": "video",
    "format": "mp4",
    "url": "https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4",
    "size": 276134947,
    "meta": { "width": 1920, "height": 1080, "duration": 634, "codec": "H.264" },
    "source": "blender",
    "tags": ["h264", "1080p"]
}
```

Rules: the `id` is lowercase-kebab-case and matches the file name, the folder matches `category`, `size` is in bytes (or `null` if you don't know it, and the checker measures it), and `format` is the extension without the dot.

**3. Check it and open a PR:**

```bash
npm run validate                               # rules, offline
npm run check -- --changed origin/main --dry   # probes just your links
```

CI runs the same checks. When they pass, a maintainer reviews and merges, and your file shows up in apps within minutes.

## Many files with one definition

For files that only differ by size or resolution, use a pattern in `data/patterns/<category>/<id>.json`. A pattern is the cartesian product of `vars`, and `{var.field}` placeholders are filled in for each combination. See `data/patterns/any-size/` for real examples. A pattern may expand to at most 500 files.

## Don't edit `status/`

It's written by the daily link check. If a link is wrong, fix the entry in `data/` instead.

## Running things locally

You need Node 20.10 or newer, and nothing to install.

| Command | What it does |
|---|---|
| `npm run validate` | all rules, no network |
| `npm test` | unit tests for the scripts |
| `npm run check -- --only video- --dry` | probe some links |
| `npm run build` | build `dist/` like CI does |
| `npm run schema` | regenerate `schema/` after changing `scripts/lib/spec.mjs` |
