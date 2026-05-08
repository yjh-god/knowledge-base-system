/**
 * Qdrant payload.text_preview：供混合检索关键字匹配 + RAG 喂给大模型。
 * 过短会漏掉同一块里靠后的制度条文（如 Excel 多行合并块中的「离职制度」）。
 */

const DEFAULT_MAX = 12000;

const buildPayloadTextPreview = (fullText) => {
    const raw = process.env.INGEST_TEXT_PREVIEW_MAX;
    const max = raw
        ? Math.max(800, Math.min(100000, Number(raw) || DEFAULT_MAX))
        : DEFAULT_MAX;
    const t = String(fullText || "");
    if (!t) return "";
    if (t.length <= max) return t;
    const head = Math.floor(max * 0.52);
    const tailLen = max - head - 5;
    return `${t.slice(0, head)}\n…\n${t.slice(-tailLen)}`;
};

module.exports = { buildPayloadTextPreview, DEFAULT_MAX };
