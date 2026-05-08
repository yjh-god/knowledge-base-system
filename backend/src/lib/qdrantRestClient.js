const http = require("http");
const https = require("https");
const { URL: NodeURL } = require("url");

const { formatFetchError } = require("./fetchErrorDetail");
const { chunkPointUuid } = require("./qdrantPointIds");
const { appendDebug } = require("./debugSessionLog");

/** Qdrant 不接受 "uuid:chunkIndex"。宽松匹配 8-4-4-4-12 + :块号（不校验 UUID version/variant，避免漏网） */
const LEGACY_COMPOSITE_POINT_ID =
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):(\d+)$/i;

const UUID_HEAD_ONLY = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i;

/** BOM / 全角冒号 / 非常规空白：仍可能拼出 Qdrant 报错的 docId:0 */
const tryLegacyCompositeToUuid = (raw) => {
    let s = String(raw ?? "");
    try {
        s = s.normalize("NFC").trim();
    } catch (_) {
        s = String(raw ?? "").trim();
    }
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const m = s.match(LEGACY_COMPOSITE_POINT_ID);
    if (m) {
        const chunkIdx = Number(m[2]);
        if (Number.isFinite(chunkIdx) && chunkIdx >= 0) return chunkPointUuid(m[1], chunkIdx);
    }
    const colonAt = Math.max(s.lastIndexOf(":"), s.lastIndexOf("\uFF1A"));
    if (colonAt > 0 && colonAt < s.length - 1) {
        const head = s.slice(0, colonAt).trim();
        const tail = s.slice(colonAt + 1).trim();
        if (/^\d+$/.test(tail) && UUID_HEAD_ONLY.test(head)) {
            const chunkIdx = Number(tail);
            if (Number.isFinite(chunkIdx) && chunkIdx >= 0) return chunkPointUuid(head, chunkIdx);
        }
    }
    return null;
};

const normalizeQdrantPointIds = (points) => {
    if (!Array.isArray(points)) return points;
    return points.map((p) => {
        if (!p || typeof p !== "object") return p;
        const id = p.id;
        if (typeof id === "number" && Number.isInteger(id) && id >= 0) return p;
        const s = id == null ? "" : String(id);
        const asUuid = tryLegacyCompositeToUuid(s);
        if (asUuid) return { ...p, id: asUuid };
        return p;
    });
};

/** SQL Server / 手误：doc_id 可能带 {}，或整条误写成 docUUID:chunk */
const normalizePayloadDocAndChunk = (docRaw, idxRaw) => {
    let doc = docRaw == null ? "" : String(docRaw).trim();
    if (doc.startsWith("{") && doc.endsWith("}")) doc = doc.slice(1, -1).trim();
    let chunkIdx = Number(idxRaw);
    const comp = doc.match(LEGACY_COMPOSITE_POINT_ID);
    if (comp) {
        doc = comp[1];
        const fromKey = Number(comp[2]);
        if (Number.isFinite(fromKey) && fromKey >= 0) chunkIdx = fromKey;
    }
    if (!doc || !Number.isFinite(chunkIdx) || chunkIdx < 0) return null;
    return { docId: doc, chunkIdx };
};

/** 发送前强制用 payload 与 chunkPointUuid 对齐 id，避免任意路径写入 docId:chunk 等非法值 */
const coercePointIdsFromPayload = (points) => {
    if (!Array.isArray(points)) return points;
    return points.map((p) => {
        if (!p || typeof p !== "object") return p;
        const pl = p.payload;
        if (!pl || typeof pl !== "object") return p;
        const pair = normalizePayloadDocAndChunk(pl.doc_id, pl.chunk_index);
        if (!pair) return p;
        return { ...p, id: chunkPointUuid(pair.docId, pair.chunkIdx) };
    });
};

/**
 * 最后一道：任意仍含「uuid:块号」的 id 或可从 payload 还原的，一律改为 chunkPointUuid。
 * 运行时曾出现 Qdrant 400：value …CC12C4EFE8C4:0 is not a valid point ID（见 debug-840c9e ingest日志）。
 */
const enforceValidQdrantIds = (points) => {
    if (!Array.isArray(points)) return points;
    return points.map((p) => {
        if (!p || typeof p !== "object") return p;
        if (typeof p.id === "number" && Number.isInteger(p.id) && p.id >= 0) return p;
        const sid = String(p.id ?? "").trim();
        if (UUID_HEAD_ONLY.test(sid)) return p;
        const fromId = tryLegacyCompositeToUuid(sid);
        if (fromId) return { ...p, id: fromId };
        const pl = p.payload;
        if (pl && typeof pl === "object") {
            const pair = normalizePayloadDocAndChunk(pl.doc_id, pl.chunk_index);
            if (pair) return { ...p, id: chunkPointUuid(pair.docId, pair.chunkIdx) };
        }
        return p;
    });
};

const assertNoCompositePointIds = (points, context) => {
    if (!Array.isArray(points)) return;
    const bad = points.find((pt) => {
        if (!pt || typeof pt !== "object") return false;
        if (typeof pt.id === "number") return false;
        const s = String(pt.id ?? "");
        return s.includes(":") || s.includes("\uFF1A");
    });
    if (bad) {
        throw new Error(
            `${context || "Qdrant upsert"}: 点 id 仍含非法复合形式（需为 UUID 或整数）: ${String(bad.id).slice(0, 96)}`
        );
    }
};

/** 发往 Qdrant 前：先拆复合 id，再按 payload 强制重写，最后再扫一遍（防中间步骤被改） */
const sanitizeQdrantPoints = (points) => {
    const a = normalizeQdrantPointIds(points);
    const b = coercePointIdsFromPayload(a);
    const c = normalizeQdrantPointIds(b);
    const d = coercePointIdsFromPayload(c);
    return enforceValidQdrantIds(d);
};

const normalizeBaseUrl = (baseUrl) => {
    if (!baseUrl) return baseUrl;
    return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 合并头：默认 Connection: close，减轻 Windows/Node fetch 复用连接遇 ECONNRESET；QDRANT_HTTP_KEEPALIVE=1 可关闭 */
const buildQdrantFetchInit = (init = {}) => {
    const keepAlive = String(process.env.QDRANT_HTTP_KEEPALIVE || "").trim() === "1";
    let headers = {};
    if (init.headers instanceof Headers) {
        headers = Object.fromEntries(init.headers.entries());
    } else if (init.headers && typeof init.headers === "object") {
        headers = { ...init.headers };
    }
    const apiKey = String(process.env.QDRANT_API_KEY || "").trim();
    if (apiKey && !Object.keys(headers).some((k) => k.toLowerCase() === "api-key")) {
        headers["api-key"] = apiKey;
    }
    if (
        !keepAlive &&
        !Object.keys(headers).some((k) => k.toLowerCase() === "connection")
    ) {
        headers.Connection = "close";
    }
    return { ...init, headers };
};

/**
 * Node 原生 http(s)、agent:false，规避 Windows 上 undici/fetch 对 localhost 偶发 ECONNRESET。
 * QDRANT_USE_NODE_HTTP=0 时回退全局 fetch。
 */
const nodeQdrantHttpOnce = (urlStr, init = {}) =>
    new Promise((resolve, reject) => {
        let u;
        try {
            u = new NodeURL(urlStr);
        } catch (e) {
            reject(e);
            return;
        }
        const isHttps = u.protocol === "https:";
        const lib = isHttps ? https : http;
        const method = String(init.method || "GET").toUpperCase();
        const headers = { ...(init.headers || {}) };
        const bodyStr =
            init.body == null || init.body === undefined
                ? null
                : typeof init.body === "string"
                  ? init.body
                  : String(init.body);
        if (
            bodyStr != null &&
            !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")
        ) {
            headers["Content-Length"] = Buffer.byteLength(bodyStr, "utf8");
        }
        const req = lib.request(
            {
                hostname: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: `${u.pathname}${u.search}`,
                method,
                headers,
                agent: false
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        status: res.statusCode,
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        async text() {
                            return raw;
                        },
                        async json() {
                            if (!raw || !String(raw).trim()) return null;
                            return JSON.parse(raw);
                        }
                    });
                });
            }
        );
        const timeoutMs = Math.max(
            5000,
            Math.min(600000, Number(process.env.QDRANT_NODE_HTTP_TIMEOUT_MS) || 120000)
        );
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Qdrant timeout ${timeoutMs}ms`));
        });
        req.on("error", reject);
        if (bodyStr != null) req.write(bodyStr, "utf8");
        req.end();
    });

/** 大 payload / 本机 Qdrant 瞬时断连时常见 ECONNRESET；有限次退避重试 */
const fetchQdrantRetriable = async (url, init) => {
    const merged = buildQdrantFetchInit(init);
    const rawN = Number(process.env.QDRANT_FETCH_MAX_ATTEMPTS);
    const maxAttempts = Number.isFinite(rawN) && rawN >= 1 ? Math.min(12, Math.floor(rawN)) : 5;
    const rawMs = Number(process.env.QDRANT_FETCH_RETRY_MS);
    const baseMs = Number.isFinite(rawMs) && rawMs >= 50 ? rawMs : 500;
    const useNode = String(process.env.QDRANT_USE_NODE_HTTP || "1").trim() !== "0";
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            // eslint-disable-next-line no-await-in-loop
            if (useNode) {
                return await nodeQdrantHttpOnce(url, merged);
            }
            return await fetch(url, merged);
        } catch (err) {
            lastErr = err;
            const code = err && err.code;
            const msg = String((err && err.message) || err || "");
            const retriable =
                code === "ECONNRESET" ||
                code === "ECONNREFUSED" ||
                code === "ETIMEDOUT" ||
                code === "EPIPE" ||
                /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|timeout/i.test(
                    msg
                );
            if (!retriable || attempt === maxAttempts - 1) throw err;
            // eslint-disable-next-line no-await-in-loop
            await sleep(baseMs * 2 ** attempt);
        }
    }
    throw lastErr;
};

const getDistanceConfig = (distance) => {
    const d = (distance || "Cosine").toLowerCase();
    if (d === "cosine") return "Cosine";
    if (d === "dot") return "Dot";
    if (d === "euclid" || d === "euclidean") return "Euclid";
    return "Cosine";
};

const qdrantRequest = async ({ url, method, body }) => {
    let sendBody = body;
    if (body && Array.isArray(body.points) && body.points.length) {
        sendBody = { ...body, points: sanitizeQdrantPoints(body.points) };
    }
    // #region agent log
    if (sendBody && Array.isArray(sendBody.points) && sendBody.points.length) {
        const s = JSON.stringify(sendBody);
        const m = s.match(/"id"\s*:\s*"([^"]+)"/);
        fetch("http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "840c9e" },
            body: JSON.stringify({
                sessionId: "840c9e",
                location: "qdrantRestClient.js:qdrantRequest",
                message: "serialized points body first id string",
                data: {
                    hypothesisId: "H5",
                    urlTail: String(url).split("/").slice(-3).join("/"),
                    firstIdInJson: m ? m[1] : null,
                    hasColonInFirstId: m ? m[1].includes(":") : null
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
    }
    // #endregion
    let res;
    try {
        res = await fetchQdrantRetriable(url, {
            method,
            headers: { "Content-Type": "application/json" },
            body: sendBody ? JSON.stringify(sendBody) : undefined
        });
    } catch (err) {
        throw new Error(`Qdrant ${formatFetchError(url, err)}`);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Qdrant request failed: ${res.status} ${text}`.slice(0, 800));
    }
    if (res.status === 204) return null;
    return res.json();
};

/** 轻量探测 Qdrant（优先 /healthz、/ ，避免 GET /collections 体量大且易触发连接问题） */
const pingQdrant = async ({ qdrantUrl }) => {
    const base = normalizeBaseUrl(qdrantUrl);
    const candidates = [`${base}/healthz`, `${base}/`, `${base}/collections`];
    let lastErr = null;
    for (const url of candidates) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const res = await fetchQdrantRetriable(url, { method: "GET" });
            if (res.ok) {
                // #region agent log
                fetch("http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Debug-Session-Id": "4d99a4"
                    },
                    body: JSON.stringify({
                        sessionId: "4d99a4",
                        hypothesisId: "H_QDRANT_PING",
                        location: "qdrantRestClient.js:pingQdrant",
                        message: "qdrant ping ok",
                        data: { path: String(url).replace(String(base), "") || "/" },
                        timestamp: Date.now()
                    })
                }).catch(() => {});
                // #endregion
                return true;
            }
            if (res.status === 404 && url.endsWith("/healthz")) continue;
            // eslint-disable-next-line no-await-in-loop
            const text = await res.text().catch(() => "");
            lastErr = new Error(`Qdrant ping: HTTP ${res.status} ${text}`.slice(0, 400));
        } catch (err) {
            if (err && err.message && err.message.startsWith("Qdrant ping:")) lastErr = err;
            else lastErr = new Error(`Qdrant ${formatFetchError(url, err)}`);
        }
    }
    throw lastErr || new Error("Qdrant ping: 无可用探测端点");
};

const getCollectionExists = async ({ qdrantUrl, collection }) => {
    const url = `${normalizeBaseUrl(qdrantUrl)}/collections/${encodeURIComponent(collection)}`;
    let res;
    try {
        res = await fetchQdrantRetriable(url, { method: "GET" });
    } catch (err) {
        throw new Error(`Qdrant ${formatFetchError(url, err)}`);
    }
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    const text = await res.text().catch(() => "");
    throw new Error(`Qdrant collection check failed: ${res.status} ${text}`.slice(0, 800));
};

const ensureCollection = async ({ qdrantUrl, collection, vectorDim, distance }) => {
    const exists = await getCollectionExists({ qdrantUrl, collection });
    if (exists) return;

    const vectors = {
        size: vectorDim,
        distance: getDistanceConfig(distance)
    };
    const url = `${normalizeBaseUrl(qdrantUrl)}/collections/${encodeURIComponent(collection)}`;
    await qdrantRequest({
        url,
        method: "PUT",
        body: { vectors }
    });
};

const upsertPoints = async ({ qdrantUrl, collection, points }) => {
    const url = `${normalizeBaseUrl(qdrantUrl)}/collections/${encodeURIComponent(collection)}/points?wait=true`;
    const normalized = sanitizeQdrantPoints(points);
    // #region agent log
    fetch("http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "840c9e" },
        body: JSON.stringify({
            sessionId: "840c9e",
            location: "qdrantRestClient.js:upsertPoints",
            message: "pre-qdrant upsert ids",
            data: {
                hypothesisId: "H1-H2-H4-FIX",
                codeMarker: "upsert-coerce-payload-v2",
                rawFirstId: points?.[0]?.id,
                normFirstId: normalized?.[0]?.id,
                rawType: typeof points?.[0]?.id,
                count: Array.isArray(points) ? points.length : -1,
                colonStillInNormId: String(normalized?.[0]?.id ?? "").includes(":")
            },
            timestamp: Date.now()
        })
    }).catch(() => {});
    const leak = Array.isArray(normalized)
        ? normalized.find((pt) => {
              const sid = String(pt && pt.id != null ? pt.id : "");
              return sid.includes(":") || sid.includes("\uFF1A");
          })
        : null;
    appendDebug({
        runId: "post-fix-upsert",
        hypothesisId: "FIX",
        location: "qdrantRestClient.js:upsertPoints",
        message: "ids after normalize+payload coerce",
        data: {
            firstId: normalized?.[0]?.id,
            colonInId: String(normalized?.[0]?.id ?? "").includes(":"),
            n: Array.isArray(normalized) ? normalized.length : -1,
            leakFirstId: leak ? leak.id : null
        }
    });
    if (leak) {
        appendDebug({
            runId: "point-id-leak",
            hypothesisId: "H_ID_LEAK",
            location: "qdrantRestClient.js:upsertPoints",
            message: "composite-like id still present after sanitize",
            data: { leakId: leak.id, n: normalized.length }
        });
    }
    assertNoCompositePointIds(normalized, "upsertPoints");
    // #endregion
    await qdrantRequest({
        url,
        method: "PUT",
        body: { points: normalized }
    });
};

const searchPoints = async ({
    qdrantUrl,
    collection,
    vector,
    limit,
    filter
}) => {
    const url = `${normalizeBaseUrl(qdrantUrl)}/collections/${encodeURIComponent(collection)}/points/search`;
    const body = {
        vector,
        limit,
        with_payload: true
    };
    if (filter) body.filter = filter;

    return qdrantRequest({
        url,
        method: "POST",
        body
    });
};

const deleteByFilter = async ({ qdrantUrl, collection, filter }) => {
    const url = `${normalizeBaseUrl(qdrantUrl)}/collections/${encodeURIComponent(collection)}/points/delete`;
    const body = { filter };
    return qdrantRequest({
        url,
        method: "POST",
        body
    });
};

const scrollPoints = async ({
    qdrantUrl,
    collection,
    limit,
    filter,
    withPayload = true,
    offset
}) => {
    const url = `${normalizeBaseUrl(qdrantUrl)}/collections/${encodeURIComponent(collection)}/points/scroll`;
    const body = {
        limit,
        with_payload: withPayload
    };
    if (filter) body.filter = filter;
    if (offset) body.offset = offset;

    return qdrantRequest({
        url,
        method: "POST",
        body
    });
};

const getCollectionInfo = async ({ qdrantUrl, collection }) => {
    const url = `${normalizeBaseUrl(qdrantUrl)}/collections/${encodeURIComponent(collection)}`;
    return qdrantRequest({ url, method: "GET" });
};

module.exports = {
    pingQdrant,
    ensureCollection,
    upsertPoints,
    searchPoints,
    deleteByFilter,
    scrollPoints,
    getCollectionInfo
};

