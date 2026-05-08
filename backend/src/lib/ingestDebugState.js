/**
 * 进程内可调观测状态（上传 ingest / embedding），用于 upload-batch debug 与排障。
 * 非持久化，单进程；多实例部署时每实例一份。
 */
let snapshot = {
    phase: "idle",
    jobId: null,
    documentId: null,
    batchId: null,
    chunkCount: 0,
    embeddedTextsCount: 0,
    lastError: null,
    updatedAt: null,
    embeddingBaseUrl: null
};

const touch = () => {
    snapshot.updatedAt = new Date().toISOString();
};

const resetForJob = (jobId, documentId, batchId = null) => {
    snapshot.phase = "claimed";
    snapshot.jobId = jobId;
    snapshot.documentId = documentId;
    snapshot.batchId = batchId || null;
    snapshot.chunkCount = 0;
    snapshot.embeddedTextsCount = 0;
    snapshot.lastError = null;
    const bu = process.env.EMBEDDING_API_BASE_URL || "";
    snapshot.embeddingBaseUrl = bu ? bu.replace(/\/+$/, "") : "";
    touch();
};

const setPhase = (phase, extra = {}) => {
    snapshot.phase = phase;
    if (Object.prototype.hasOwnProperty.call(extra, "lastError")) {
        const le = extra.lastError;
        snapshot.lastError = le == null ? null : String(le).slice(0, 500);
    }
    if (phase === "idle") {
        snapshot.jobId = null;
        snapshot.documentId = null;
        snapshot.batchId = null;
        snapshot.chunkCount = 0;
        snapshot.embeddedTextsCount = 0;
        snapshot.embeddingBaseUrl = null;
    }
    touch();
};

const setChunkStats = (chunkCount) => {
    snapshot.chunkCount = chunkCount;
    touch();
};

const setEmbeddedCount = (n) => {
    snapshot.embeddedTextsCount = n;
    touch();
};

const getIngestDebugSnapshot = () => ({ ...snapshot });

module.exports = {
    resetForJob,
    setPhase,
    setChunkStats,
    setEmbeddedCount,
    getIngestDebugSnapshot
};
