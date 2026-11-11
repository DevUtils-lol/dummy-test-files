/**
 * Network probing of a single link, without downloading it.
 *
 * A GET with `Range: bytes=0-63` is answered even by servers that refuse HEAD, its
 * Content-Range reveals the real size of 100 GB files, and the first bytes let us check
 * the file's signature (a PNG really is a PNG). Servers that ignore Range get their body
 * cancelled after the first chunk. Slow hosts that time out get one HEAD retry.
 */
import { HTML_FORMATS, LIMITS, SIGNATURE_BYTES, matchesSignature } from "./spec.mjs";

export const USER_AGENT = "test-files link checker (+https://github.com/DevUtils-lol/dummy-test-files)";
const RATE_LIMITED = new Set([429, 503, 509]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {{ ok: boolean, http: number, size: number | null, contentType: string | null, cors: boolean,
 *   signature: boolean | null, finalUrl?: string, error?: string, rateLimited?: boolean, retryAfter?: number }} ProbeResult
 */

/** Read up to `n` bytes from a response body, then stop the download. */
async function firstBytes(res, n) {
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const out = new Uint8Array(n);
    let got = 0;
    try {
        while (got < n) {
            const { done, value } = await reader.read();
            if (done) break;
            const take = Math.min(n - got, value.byteLength);
            out.set(value.subarray(0, take), got);
            got += take;
        }
    } finally {
        reader.cancel().catch(() => undefined);
    }
    return out.subarray(0, got);
}

/**
 * One request. Never throws.
 * @param {{ url: string, format: string, size: number | null, approxSize?: boolean, signature?: false }} file
 * @param {"GET" | "HEAD"} method
 * @param {number} timeout
 * @returns {Promise<ProbeResult>}
 */
export async function request(file, method, timeout) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
        const res = await fetch(file.url, {
            method,
            redirect: "follow",
            signal: ac.signal,
            headers: {
                ...(method === "GET" ? { Range: `bytes=0-${SIGNATURE_BYTES - 1}` } : {}),
                "User-Agent": USER_AGENT,
                Accept: "*/*",
                // Compressed bodies would hide the real bytes and size.
                "Accept-Encoding": "identity",
                // Any third-party origin: tells consumers whether browsers can fetch it directly.
                Origin: "https://example.com",
            },
        });
        const bytes = method === "GET" ? await firstBytes(res, SIGNATURE_BYTES) : (res.body?.cancel().catch(() => undefined), new Uint8Array());
        const contentType = res.headers.get("content-type");
        const range = res.headers.get("content-range")?.match(/\/(\d+)\s*$/);
        const length = res.headers.get("content-length");
        const size = range ? Number(range[1]) : res.status === 200 && length ? Number(length) : null;
        const cors = res.headers.has("access-control-allow-origin");
        const retryAfter = Number(res.headers.get("retry-after")) || undefined;
        const signature = res.ok && file.signature !== false ? matchesSignature(file.format, bytes) : null;
        const base = { http: res.status, size, contentType, cors, signature, retryAfter, finalUrl: res.url };

        if (!(res.status === 200 || res.status === 206)) return { ok: false, ...base, error: `HTTP ${res.status}` };
        if (contentType && /text\/html|application\/xhtml/i.test(contentType) && !HTML_FORMATS.has(file.format)) return { ok: false, ...base, error: "Got an HTML page instead of the file (soft 404 / login wall)" };
        if (signature === false) return { ok: false, ...base, error: `Content doesn't look like a .${file.format} file (signature mismatch)` };
        if (file.size && size && !file.approxSize) {
            const drift = Math.abs(size - file.size) / file.size;
            if (drift > LIMITS.sizeDrift) return { ok: false, ...base, error: `Size changed: expected ${file.size}, got ${size}` };
        }
        return { ok: true, ...base };
    } catch (e) {
        return { ok: false, http: 0, size: null, contentType: null, cors: false, signature: null, error: e.name === "AbortError" ? `Timed out after ${timeout} ms` : String(e.cause?.code ?? e.message) };
    } finally {
        clearTimeout(timer);
    }
}

/** Retry rate-limited answers, honouring Retry-After (capped at 60 s), up to 3 times. */
async function withBackoff(run) {
    for (let attempt = 0; ; attempt++) {
        const r = await run();
        if (!RATE_LIMITED.has(r.http)) return r;
        if (attempt >= 3) return { ...r, rateLimited: true, error: `Rate-limited (HTTP ${r.http})` };
        await sleep(Math.min(60_000, (r.retryAfter ?? 5 * 2 ** attempt) * 1000));
    }
}

/**
 * Probe a link the way the source asks ("range" GET by default, or "head").
 * @param {{ url: string, format: string, size: number | null, approxSize?: boolean }} file
 * @param {{ method?: "range" | "head", timeout?: number }} [opts]
 * @returns {Promise<ProbeResult>}
 */
export async function probe(file, { method = "range", timeout = 20_000 } = {}) {
    if (method === "head") return withBackoff(() => request(file, "HEAD", timeout * 2));
    const first = await withBackoff(() => request(file, "GET", timeout));
    if (first.ok || first.rateLimited || !/Timed out|ETIMEDOUT|ECONNRESET|UND_ERR/.test(first.error ?? "")) return first;
    return withBackoff(() => request(file, "HEAD", timeout * 2));
}

/** Max simultaneous requests to one host, and the minimum gap between starting them. */
const PER_HOST = 2;
const HOST_GAP_MS = 300;

/**
 * Run `fn` over `items` with at most `n` in flight overall and PER_HOST per host,
 * so a big catalog never hammers one server.
 * @template T, R
 * @param {T[]} items
 * @param {number} n
 * @param {(item: T, i: number) => Promise<R>} fn
 * @param {(item: T) => string} hostOf
 * @returns {Promise<R[]>}
 */
export async function politePool(items, n, fn, hostOf) {
    const out = new Array(items.length);
    const busy = new Map();
    const lastStart = new Map();
    const pending = items.map((_, i) => i);
    const worker = async () => {
        for (;;) {
            const now = Date.now();
            const k = pending.findIndex((i) => {
                const h = hostOf(items[i]);
                return (busy.get(h) ?? 0) < PER_HOST && now - (lastStart.get(h) ?? 0) >= HOST_GAP_MS;
            });
            if (k < 0) {
                if (!pending.length) return;
                await sleep(50);
                continue;
            }
            const i = pending.splice(k, 1)[0];
            const host = hostOf(items[i]);
            busy.set(host, (busy.get(host) ?? 0) + 1);
            lastStart.set(host, Date.now());
            try {
                out[i] = await fn(items[i], i);
            } finally {
                busy.set(host, busy.get(host) - 1);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
}
