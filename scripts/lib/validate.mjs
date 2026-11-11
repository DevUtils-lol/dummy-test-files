/**
 * Offline validation of the whole catalog: shape, naming, file placement, URL safety and
 * uniqueness. No network — link probing lives in probe.mjs. Every problem is reported at
 * once (not just the first) with the file it came from, so contributors fix a PR in one go.
 */
import { BLOCKED_HOSTS, CATEGORIES, LIMITS, META_FIELDS, PREVIEW_KINDS } from "./spec.mjs";
import { expandPattern } from "./expand.mjs";

const ID_RE = new RegExp(LIMITS.idPattern);
const TAG_RE = new RegExp(LIMITS.tagPattern);
const FORMAT_RE = new RegExp(LIMITS.formatPattern);
const PLACEHOLDER_ID_RE = /^[a-z0-9{}.\-_]+$/;

const SOURCE_KEYS = new Set(["$schema", "_path", "id", "name", "homepage", "license", "check", "allowHttp", "notes"]);
const COMMON_KEYS = ["$schema", "_path", "id", "name", "category", "format", "url", "size", "approxSize", "meta", "source", "tags", "description", "preview"];
const FILE_KEYS = new Set(COMMON_KEYS);
const PATTERN_KEYS = new Set([...COMMON_KEYS, "idTemplate", "vars", "exclude"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max && v === v.trim();

/** Hosts that point back at the machine or a private network. */
function isPrivateHost(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // any IPv4 literal: real hosts have names
    if (h.includes(":")) return true; // IPv6 literal
    return false;
}

const blocked = (host) => BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));

/** Normalised form used to spot the same file added twice. */
export function urlKey(url) {
    try {
        const u = new URL(url);
        u.hash = "";
        u.hostname = u.hostname.toLowerCase();
        return `${u.hostname}${u.pathname}${u.search}`;
    } catch {
        return url;
    }
}

/**
 * @param {{ sources: Record<string, any>, sourceList: any[], files: any[], patterns: any[], parseErrors: any[] }} data
 * @returns {{ errors: { path: string, message: string }[], entries: any[] }}
 */
export function validate(data) {
    const errors = [...data.parseErrors];
    const err = (p, message) => errors.push({ path: p, message });

    // ---- sources --------------------------------------------------------------------
    const sourceIds = new Set();
    for (const s of data.sourceList) {
        const p = s._path;
        for (const k of Object.keys(s)) if (!SOURCE_KEYS.has(k)) err(p, `Unknown field "${k}"`);
        if (!isStr(s.id, LIMITS.idMax) || !ID_RE.test(s.id)) err(p, `"id" must be lowercase-kebab-case (got ${JSON.stringify(s.id)})`);
        else if (p !== `data/sources/${s.id}.json`) err(p, `File must be named data/sources/${s.id}.json`);
        if (sourceIds.has(s.id)) err(p, `Duplicate source id "${s.id}"`);
        sourceIds.add(s.id);
        if (!isStr(s.name, LIMITS.nameMax)) err(p, `"name" is required (≤ ${LIMITS.nameMax} chars)`);
        if (!isStr(s.license, 200)) err(p, `"license" is required — say under which terms the files may be used`);
        if (!isStr(s.homepage, LIMITS.urlMax) || !/^https?:\/\//.test(s.homepage)) err(p, `"homepage" must be a URL`);
        if (s.check !== undefined && !["range", "head"].includes(s.check)) err(p, `"check" must be "range" or "head"`);
        if (s.allowHttp !== undefined && typeof s.allowHttp !== "boolean") err(p, `"allowHttp" must be true or false`);
        if (s.notes !== undefined && !isStr(s.notes, 500)) err(p, `"notes" must be a string ≤ 500 chars`);
    }

    // ---- shared field checks ----------------------------------------------------------
    const checkCommon = (e, p, kind) => {
        const keys = kind === "file" ? FILE_KEYS : PATTERN_KEYS;
        for (const k of Object.keys(e)) if (!keys.has(k)) err(p, `Unknown field "${k}"`);
        if (!isStr(e.id, LIMITS.idMax) || !ID_RE.test(e.id)) err(p, `"id" must be lowercase-kebab-case, ≤ ${LIMITS.idMax} chars (got ${JSON.stringify(e.id)})`);
        if (!CATEGORIES.includes(e.category)) err(p, `"category" must be one of: ${CATEGORIES.join(", ")}`);
        else if (ID_RE.test(e.id ?? "") && p !== `data/${kind}s/${e.category}/${e.id}.json`) err(p, `File must be at data/${kind}s/${e.category}/${e.id}.json`);
        if (!isStr(e.name, LIMITS.nameMax)) err(p, `"name" is required (≤ ${LIMITS.nameMax} chars)`);
        if (typeof e.source !== "string" || !sourceIds.has(e.source)) err(p, `"source" ${JSON.stringify(e.source)} doesn't exist — add data/sources/<id>.json first`);
        if (e.description !== undefined && !isStr(e.description, LIMITS.descriptionMax)) err(p, `"description" must be ≤ ${LIMITS.descriptionMax} chars`);
        if (e.preview !== undefined && !PREVIEW_KINDS.includes(e.preview)) err(p, `"preview" must be one of: ${PREVIEW_KINDS.join(", ")}`);
        if (e.approxSize !== undefined && typeof e.approxSize !== "boolean") err(p, `"approxSize" must be true or false`);
        if (e.tags !== undefined) {
            if (!Array.isArray(e.tags) || e.tags.length > LIMITS.tagsMax) err(p, `"tags" must be a list of at most ${LIMITS.tagsMax}`);
            else if (kind === "file") {
                for (const t of e.tags) if (!isStr(t, LIMITS.tagMax) || !TAG_RE.test(t)) err(p, `Tag ${JSON.stringify(t)} must be letters, digits, spaces or .+_- and ≤ ${LIMITS.tagMax} chars`);
                if (new Set(e.tags).size !== e.tags.length) err(p, `"tags" has duplicates`);
            }
        }
    };

    /** Checks that only make sense on a concrete (expanded) entry. */
    const checkConcrete = (e, p, label) => {
        const where = label ? `${label}: ` : "";
        if (label && (!ID_RE.test(e.id) || e.id.length > LIMITS.idMax)) err(p, `${where}expanded id must be lowercase-kebab-case, ≤ ${LIMITS.idMax} chars`);
        if (typeof e.format !== "string" || !FORMAT_RE.test(e.format)) err(p, `${where}"format" must be the lowercase extension without a dot (got ${JSON.stringify(e.format)})`);
        if (e.size !== null && (!Number.isSafeInteger(e.size) || e.size <= 0 || e.size > LIMITS.sizeMax)) err(p, `${where}"size" must be a positive whole number of bytes, or null if unknown`);
        if (e.meta !== undefined) {
            if (!isObj(e.meta)) err(p, `${where}"meta" must be an object`);
            else for (const [k, v] of Object.entries(e.meta)) {
                if (k === "codec") {
                    if (!isStr(v, 40)) err(p, `${where}meta.codec must be a short string`);
                } else if (!META_FIELDS[k]) err(p, `${where}Unknown meta field "${k}" (allowed: codec, ${Object.keys(META_FIELDS).join(", ")})`);
                else if (typeof v !== "number" || !Number.isFinite(v) || v < META_FIELDS[k].min || v > META_FIELDS[k].max) err(p, `${where}meta.${k} must be a number between ${META_FIELDS[k].min} and ${META_FIELDS[k].max}`);
            }
        }
        if (e.tags) for (const t of e.tags) if (!isStr(t, LIMITS.tagMax) || !TAG_RE.test(t)) err(p, `${where}Tag ${JSON.stringify(t)} must be letters, digits, spaces or .+_- and ≤ ${LIMITS.tagMax} chars`);
        checkUrl(e, p, where);
    };

    const checkUrl = (e, p, where) => {
        if (typeof e.url !== "string" || e.url.length > LIMITS.urlMax) return err(p, `${where}"url" is required (≤ ${LIMITS.urlMax} chars)`);
        let u;
        try {
            u = new URL(e.url);
        } catch {
            return err(p, `${where}"url" is not a valid URL`);
        }
        const src = data.sources[e.source];
        if (u.protocol === "http:" && !src?.allowHttp) err(p, `${where}"url" must be https:// (plain http is only accepted for sources marked "allowHttp")`);
        else if (u.protocol !== "https:" && u.protocol !== "http:") err(p, `${where}"url" must be an https:// link`);
        if (u.username || u.password) err(p, `${where}"url" must not contain credentials`);
        if (u.hash) err(p, `${where}"url" must not contain a #fragment`);
        if (isPrivateHost(u.hostname)) err(p, `${where}"url" must use a public host name (no IPs, localhost or private names)`);
        if (blocked(u.hostname.toLowerCase())) err(p, `${where}${u.hostname} is not accepted (file lockers and link shorteners break direct downloads)`);
        if (/[?&](token|sig|signature|expires|x-amz-signature|access_token|key)=/i.test(u.search)) err(p, `${where}"url" looks like a signed/expiring link — use a permanent public URL`);
    };

    // ---- files ------------------------------------------------------------------------
    for (const f of data.files) {
        checkCommon(f, f._path, "file");
        checkConcrete(f, f._path, "");
    }

    // ---- patterns ---------------------------------------------------------------------
    const expanded = [];
    for (const pat of data.patterns) {
        const p = pat._path;
        checkCommon(pat, p, "pattern");
        if (typeof pat.idTemplate !== "string" || !pat.idTemplate.includes("{") || !PLACEHOLDER_ID_RE.test(pat.idTemplate)) err(p, `"idTemplate" must contain a {var.key} placeholder`);
        if (!isObj(pat.vars) || !Object.keys(pat.vars).length || Object.values(pat.vars).some((vs) => !Array.isArray(vs) || !vs.length || vs.some((v) => !isObj(v) || typeof v.key !== "string"))) {
            err(p, `"vars" must map names to non-empty lists of objects with a "key"`);
            continue;
        }
        if (pat.exclude !== undefined && (!Array.isArray(pat.exclude) || pat.exclude.some((x) => !isObj(x)))) err(p, `"exclude" must be a list of { var: key } objects`);
        try {
            const items = expandPattern(pat);
            for (const item of items) checkConcrete(item, p, item.id);
            expanded.push(...items);
        } catch (e) {
            err(p, `Pattern can't be expanded: ${e.message}`);
        }
    }

    // ---- global uniqueness ------------------------------------------------------------
    const entries = [...data.files.map(({ $schema, ...f }) => f), ...expanded];
    const byId = new Map();
    const byUrl = new Map();
    for (const e of entries) {
        if (typeof e.id === "string") {
            if (byId.has(e.id)) err(e._path, `Duplicate id "${e.id}" (also in ${byId.get(e.id)})`);
            else byId.set(e.id, e._path);
        }
        if (typeof e.url === "string") {
            const k = urlKey(e.url);
            if (byUrl.has(k)) err(e._path, `This URL is already in the catalog (${byUrl.get(k)})`);
            else byUrl.set(k, `${e._path}${e.patternId ? ` → ${e.id}` : ""}`);
        }
    }
    for (const pat of data.patterns) if (byId.has(pat.id) && byId.get(pat.id) !== pat._path) err(pat._path, `Pattern id "${pat.id}" clashes with a file id`);

    return { errors, entries };
}
