/**
 * 写入 Qdrant payload / 任务元数据的向量模型版本标识。
 */

const getEmbeddingModelVersion = () => {
    const explicit = String(process.env.EMBEDDING_MODEL_VERSION || "").trim();
    if (explicit) return explicit.slice(0, 200);
    const model = String(process.env.EMBEDDING_MODEL || "unknown").trim() || "unknown";
    const dimRaw = process.env.EMBEDDING_VECTOR_DIM;
    const dim = dimRaw != null && String(dimRaw).trim() !== "" ? String(dimRaw).trim() : "";
    return dim ? `${model}@${dim}d` : model;
};

module.exports = {
    getEmbeddingModelVersion
};
