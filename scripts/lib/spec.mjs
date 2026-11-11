/**
 * The single source of truth for the catalog: categories, field rules, limits and
 * file signatures. The JSON Schemas in /schema are generated from this file
 * (`npm run schema`) so editors, CI and the build can never disagree.
 */

/** Bump only for breaking changes to the published format; consumers read /v<N>/. */
export const FORMAT_VERSION = 1;

export const CATEGORIES = [
    "any-size",
    "video",
    "streaming",
    "audio",
    "image",
    "document",
    "spreadsheet",
    "data",
    "archive",
    "code",
    "ebook",
    "3d",
    "font",
    "security",
];

export const PREVIEW_KINDS = ["image", "video", "audio", "pdf", "text", "none"];

/** How a file can be previewed when the entry doesn't say. */
export const PREVIEW_BY_FORMAT = {
    jpg: "image", jpeg: "image", jfif: "image", jpe: "image", png: "image", gif: "image", webp: "image", avif: "image", svg: "image", bmp: "image", ico: "image",
    mp4: "video", webm: "video", mov: "video", m4v: "video", ogv: "video", mkv: "video",
    mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio", aac: "audio", opus: "audio",
    pdf: "pdf",
    json: "text", ndjson: "text", csv: "text", tsv: "text", txt: "text", xml: "text", xsd: "text", geojson: "text", m3u8: "text", mpd: "text", md: "text", yaml: "text", yml: "text", kml: "text",
    html: "text", css: "text", js: "text", py: "text", rb: "text", go: "text", java: "text", c: "text", h: "text", cpp: "text", cs: "text", swift: "text", sh: "text", bat: "text", pl: "text", vb: "text", sql: "text", htaccess: "text", obj: "text", rtf: "text",
};

export const previewOf = (format) => PREVIEW_BY_FORMAT[String(format).toLowerCase()] ?? "none";

/** Formats where an HTML response is the real file, not a soft 404 / login wall. */
export const HTML_FORMATS = new Set(["html", "htm", "xhtml"]);

export const LIMITS = {
    idPattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    idMax: 80,
    nameMax: 90,
    descriptionMax: 300,
    tagsMax: 12,
    tagMax: 32,
    tagPattern: "^[A-Za-z0-9][A-Za-z0-9.+_ -]*$",
    /** Lowercase extension without the dot; compound ones like "tar.gz" are allowed. */
    formatPattern: "^[a-z0-9]{1,10}(\\.[a-z0-9]{1,5})?$",
    urlMax: 2048,
    /** 1 TB — anything bigger is almost certainly a typo. */
    sizeMax: 1_099_511_627_776,
    /** Upstream sizes may drift a little (re-encodes, metadata); more than this is a different file. */
    sizeDrift: 0.05,
};

/** Meta fields and their numeric ranges. `codec` is the only string. */
export const META_FIELDS = {
    width: { min: 1, max: 1_000_000 },
    height: { min: 1, max: 1_000_000 },
    duration: { min: 0, max: 1_000_000 },
    pages: { min: 1, max: 10_000_000 },
    rows: { min: 0, max: 100_000_000_000 },
};

/**
 * Hosts that are never accepted: file lockers and link shorteners serve HTML
 * interstitials, rotate URLs, break hot-linking or hide where a file really lives.
 */
export const BLOCKED_HOSTS = [
    "bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "ow.ly", "buff.ly", "rebrand.ly", "cutt.ly",
    "drive.google.com", "docs.google.com", "dropbox.com", "www.dropbox.com", "dl.dropboxusercontent.com",
    "mega.nz", "mega.co.nz", "mediafire.com", "www.mediafire.com", "wetransfer.com", "we.tl",
    "1drv.ms", "onedrive.live.com", "sendspace.com", "zippyshare.com", "4shared.com", "rapidgator.net",
    "uploaded.net", "anonfiles.com", "file.io", "transfer.sh", "gofile.io", "pixeldrain.com",
];

/**
 * Magic bytes per format, checked against the first bytes of every link so a host can't
 * silently swap a file for something else. Formats without an entry (text, ISO, …) are
 * only checked for size and content type. Each alternative is a list of [offset, bytes].
 */
const ISO_BMFF = ["ftyp", "moov", "mdat", "free", "wide", "skip", "styp"].map((box) => [[4, box]]);
const ZIP = [[[0, "PK\x03\x04"]], [[0, "PK\x05\x06"]], [[0, "PK\x07\x08"]]];
const OLE = [[[0, "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"]]];
export const SIGNATURES = {
    png: [[[0, "\x89PNG\r\n\x1A\n"]]],
    jpg: [[[0, "\xFF\xD8\xFF"]]], jpeg: [[[0, "\xFF\xD8\xFF"]]], jfif: [[[0, "\xFF\xD8\xFF"]]], jpe: [[[0, "\xFF\xD8\xFF"]]],
    gif: [[[0, "GIF87a"]], [[0, "GIF89a"]]],
    webp: [[[0, "RIFF"], [8, "WEBP"]]],
    bmp: [[[0, "BM"]]],
    ico: [[[0, "\x00\x00\x01\x00"]]],
    tif: [[[0, "II*\x00"]], [[0, "MM\x00*"]]], tiff: [[[0, "II*\x00"]], [[0, "MM\x00*"]]],
    psd: [[[0, "8BPS"]]],
    avif: ISO_BMFF, heic: ISO_BMFF, heif: ISO_BMFF,
    mp4: ISO_BMFF, m4v: ISO_BMFF, m4a: ISO_BMFF, mov: ISO_BMFF, "3gp": ISO_BMFF, m4s: ISO_BMFF,
    webm: [[[0, "\x1A\x45\xDF\xA3"]]], mkv: [[[0, "\x1A\x45\xDF\xA3"]]],
    ogg: [[[0, "OggS"]]], ogv: [[[0, "OggS"]]], oga: [[[0, "OggS"]]], opus: [[[0, "OggS"]]],
    wav: [[[0, "RIFF"], [8, "WAVE"]]],
    avi: [[[0, "RIFF"], [8, "AVI "]]],
    flac: [[[0, "fLaC"]], [[0, "ID3"]]],
    mp3: [[[0, "ID3"]]],
    aac: [[[0, "ID3"]], [[0, "ADIF"]]],
    aiff: [[[0, "FORM"]]], aif: [[[0, "FORM"]]],
    mid: [[[0, "MThd"]]], midi: [[[0, "MThd"]]],
    pdf: [[[0, "%PDF"]]],
    zip: ZIP, docx: ZIP, xlsx: ZIP, pptx: ZIP, odt: ZIP, ods: ZIP, odp: ZIP, epub: ZIP, jar: ZIP, apk: ZIP, kmz: ZIP,
    doc: OLE, xls: OLE, ppt: OLE, msi: OLE,
    gz: [[[0, "\x1F\x8B"]]], tgz: [[[0, "\x1F\x8B"]]],
    bz2: [[[0, "BZh"]]],
    xz: [[[0, "\xFD7zXZ\x00"]]],
    "7z": [[[0, "7z\xBC\xAF\x27\x1C"]]],
    rar: [[[0, "Rar!\x1A\x07"]]],
    zst: [[[0, "\x28\xB5\x2F\xFD"]]],
    exe: [[[0, "MZ"]]],
    parquet: [[[0, "PAR1"]]],
    sqlite: [[[0, "SQLite format 3\x00"]]],
    glb: [[[0, "glTF"]]],
    ttf: [[[0, "\x00\x01\x00\x00"]], [[0, "true"]]],
    otf: [[[0, "OTTO"]]],
    ttc: [[[0, "ttcf"]]],
    woff: [[[0, "wOFF"]]],
    woff2: [[[0, "wOF2"]]],
    wasm: [[[0, "\x00asm"]]],
    class: [[[0, "\xCA\xFE\xBA\xBE"]]],
};

const FRAME_SYNC = new Set(["mp3", "aac"]);

/** Bytes needed to check every signature above. */
export const SIGNATURE_BYTES = 64;

/**
 * Does `bytes` start like a `format` file? Returns null when the format has no known
 * signature or not enough bytes were received to tell.
 * @param {string} format
 * @param {Uint8Array} bytes
 * @returns {boolean | null}
 */
export function matchesSignature(format, bytes) {
    // "tar.gz" is checked as a gzip file, "tar.xz" as xz.
    const alternatives = SIGNATURES[format] ?? SIGNATURES[String(format).split(".").pop()];
    if (!alternatives || !bytes?.length) return null;
    const need = Math.max(...alternatives.flat().map(([off, s]) => off + s.length));
    if (bytes.length < Math.min(need, 12)) return null;
    // MPEG audio frames start with an 11-bit sync word; the remaining header bits vary.
    if (FRAME_SYNC.has(format) && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;
    return alternatives.some((parts) => parts.every(([off, s]) => [...s].every((ch, i) => bytes[off + i] === ch.charCodeAt(0))));
}

/** Build output layout. */
export const BUILD = {
    /** Files per shard; big categories split into several shards that load in parallel. */
    shardMax: 2000,
    /** Old shards stay published this long so clients holding a cached index never 404. */
    retentionDays: 14,
};
