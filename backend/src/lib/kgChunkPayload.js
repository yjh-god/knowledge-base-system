/**
 * 知识图谱 / 块节点：在 Qdrant payload 上附加业务可读字段（与 SQL documents 元数据对齐）。
 * content 长度由 INGEST_KG_CHUNK_TEXT_MAX 控制（0 表示不写全文摘录，仅保留 text_preview）。
 */

const clipText = (text, max) => {
    const s = String(text ?? "");
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
};

const departmentFallback = (caption, visibleDeptIds) => {
    const c = String(caption || "").trim();
    if (c) return c;
    const a = Array.isArray(visibleDeptIds) ? visibleDeptIds : [];
    if (a.length === 0) return "";
    return a.map((x) => String(x)).join(", ");
};

/**
 * @param {object} opts
 * @param {string} opts.chunkText
 * @param {string} [opts.filePathInPayload]
 * @param {unknown[]} [opts.visibleDeptIds]
 * @param {object} [opts.graphDocMeta]
 * @param {string} [opts.graphDocMeta.title]
 * @param {string|null} [opts.graphDocMeta.knowledgeType]
 * @param {string|null} [opts.graphDocMeta.author]
 * @param {string|null} [opts.graphDocMeta.docVersion]
 * @param {string|null} [opts.graphDocMeta.sourceUri]
 * @param {string|null} [opts.graphDocMeta.departmentCaption]
 * @param {string|null} [opts.graphDocMeta.docCreatedAt]
 * @returns {Record<string, unknown>}
 */
const buildKgChunkPayload = ({
    chunkText,
    filePathInPayload,
    visibleDeptIds,
    graphDocMeta = {}
}) => {
    const maxRaw = Number(process.env.INGEST_KG_CHUNK_TEXT_MAX);
    const max =
        Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(200_000, Math.floor(maxRaw)) : 12_000;
    const omitContent = String(process.env.INGEST_KG_CHUNK_TEXT_MAX || "").trim() === "0";

    const title = String(graphDocMeta.title || "").trim();
    const source =
        String(graphDocMeta.sourceUri || "").trim() || String(filePathInPayload || "").trim();

    const base = {
        node_kind: "chunk",
        title: title || null,
        knowledge_type: graphDocMeta.knowledgeType || null,
        author: String(graphDocMeta.author || "").trim() || null,
        version: String(graphDocMeta.docVersion || "").trim() || null,
        create_time: graphDocMeta.docCreatedAt || null,
        source: source || null,
        department: departmentFallback(graphDocMeta.departmentCaption, visibleDeptIds) || null
    };

    if (omitContent) {
        return base;
    }

    return {
        ...base,
        content: clipText(chunkText, max)
    };
};

module.exports = { buildKgChunkPayload, clipText };
