const normalizeBaseUrl = (baseUrl) => {
    if (!baseUrl) return baseUrl;
    return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
};

const qdrantRequest = async ({ url, method, body, apiKey }) => {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, {
        method: method || "GET",
        headers,
        body: body != null ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch (_) {
        /* ignore */
    }
    return { ok: res.ok, status: res.status, text, json };
};

/**
 * PRD §13.1：为常用过滤字段建 payload 索引（幂等：已存在时忽略 4xx）。
 */
const ensureKbPayloadIndexes = async ({
    qdrantUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333",
    collection = process.env.QDRANT_COLLECTION || "kb_chunks",
    apiKey = process.env.QDRANT_API_KEY || ""
} = {}) => {
    const base = normalizeBaseUrl(qdrantUrl);
    const fields = [
        { field_name: "doc_id", field_schema: "keyword" },
        { field_name: "file_name", field_schema: "keyword" },
        { field_name: "sheet_name", field_schema: "keyword" },
        { field_name: "visible_department_ids", field_schema: "keyword" },
        { field_name: "page_start", field_schema: "integer" },
        { field_name: "page_end", field_schema: "integer" },
        { field_name: "slide_index", field_schema: "integer" },
        { field_name: "section_heading", field_schema: "keyword" },
        { field_name: "embedding_model_version", field_schema: "keyword" },
        { field_name: "knowledge_type", field_schema: "keyword" },
        { field_name: "node_kind", field_schema: "keyword" }
    ];

    const results = [];
    for (const spec of fields) {
        const url = `${base}/collections/${encodeURIComponent(collection)}/index`;
        const { ok, status, text } = await qdrantRequest({
            url,
            method: "PUT",
            body: spec,
            apiKey
        });
        const exists =
            /already exists|already been created|duplicate/i.test(text || "") ||
            status === 409;
        results.push({
            field: spec.field_name,
            ok: ok || exists,
            status,
            note: exists ? "exists" : ok ? "created" : text?.slice(0, 200)
        });
    }
    return results;
};

module.exports = { ensureKbPayloadIndexes };
