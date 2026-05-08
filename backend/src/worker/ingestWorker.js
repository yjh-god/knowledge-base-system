const fs = require("fs");
const path = require("path");

const { defaultChunking } = require("../lib/chunking");
const { embedTexts } = require("../lib/embeddingClient");
const { ensureCollection, upsertPoints } = require("../lib/qdrantRestClient");
const { parseFileToChunks } = require("../parser/loadChunks");
const { setChunkStats, setEmbeddedCount, setPhase } = require("../lib/ingestDebugState");
const { md5Hex, sha256Hex } = require("../lib/contentFingerprints");
const { getDocumentIngestState } = require("../lib/documentIngestGate");
const { deleteVectorsByDocId } = require("./deleteWorker");
const { chunkPointUuid } = require("../lib/qdrantPointIds");
const { buildPayloadTextPreview } = require("../lib/payloadPreview");
const { normalizeVisibleDeptIdsForPayload } = require("../lib/deptIdsForQdrant");
const { getEmbeddingModelVersion } = require("../lib/embeddingModelVersion");
const { buildKgChunkPayload } = require("../lib/kgChunkPayload");
const {
    isKgExtractEnabled,
    deleteKgDataForDocId,
    extractAndPersistKgForIngest
} = require("../lib/kgExtractPersist");

/**
 * 入库单文件；返回 { skipped, contentMd5, contentHash }。
 * skipped=true：已 indexed 且 indexed_content_md5 与当前文件 MD5 一致，未调用 embedding。
 */
const ingestSingleTextFile = async ({
    filePath,
    docId,
    filePathInPayload,
    visibleDeptIds,
    mimeType,
    docTitle = null,
    chunking = defaultChunking,
    qdrantCollection,
    qdrantDistance,
    graphDocMeta = null
}) => {
    const qdrantUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333";
    const collection = qdrantCollection || process.env.QDRANT_COLLECTION || "kb_chunks";
    const distance = qdrantDistance || process.env.QDRANT_DISTANCE || "Cosine";
    const embeddingBatchSize = process.env.EMBEDDING_BATCH_SIZE
        ? Number(process.env.EMBEDDING_BATCH_SIZE)
        : 16;
    const embeddingModel = process.env.EMBEDDING_MODEL || "";
    const embeddingModelVersion = getEmbeddingModelVersion();

    const raw = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const docTitleNorm =
        docTitle != null && String(docTitle).trim()
            ? String(docTitle).trim().slice(0, 512)
            : "";
    const contentMd5 = md5Hex(raw);
    const contentHash = sha256Hex(raw);
    const indexedAt = new Date().toISOString();

    const state = await getDocumentIngestState(docId);
    if (
        state &&
        state.status === "indexed" &&
        state.indexed_content_md5 &&
        state.indexed_content_md5 === contentMd5
    ) {
        setPhase("skipped_unchanged_md5");
        return { skipped: true, contentMd5, contentHash, indexMeta: null };
    }

    if (state && state.status === "indexed") {
        setPhase("delete_stale_vectors");
        await deleteVectorsByDocId({ docId });
        if (isKgExtractEnabled()) {
            try {
                await deleteKgDataForDocId(docId);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.warn("[ingest] deleteKgDataForDocId:", (e && e.message) || e);
            }
        }
    }

    const chunks = await parseFileToChunks({
        filePath,
        mimeType: mimeType || "text/plain",
        chunking
    });

    if (chunks.length === 0) {
        throw new Error(
            "无可索引正文：文件无文本或无法解析（如旧版二进制 .ppt 请另存为 PPTX/PDF；加密/损坏文件请检查源文件）"
        );
    }

    setChunkStats(chunks.length);

    /* 不在此单独 ping：与 ensureCollection 重复且旧路径易打 /collections；连通性由下方 Qdrant 请求 + 重试保证 */

    const dimFromEnv = process.env.EMBEDDING_VECTOR_DIM
        ? Number(process.env.EMBEDDING_VECTOR_DIM)
        : NaN;
    const canEnsureBeforeEmbed = Number.isFinite(dimFromEnv) && dimFromEnv > 0;

    if (canEnsureBeforeEmbed) {
        setPhase("ensure_collection");
        await ensureCollection({
            qdrantUrl,
            collection,
            vectorDim: dimFromEnv,
            distance
        });
    }

    setPhase("embedding");
    const embeddings = await embedTexts(chunks.map((c) => c.text));
    setEmbeddedCount(embeddings.length);

    const vectorDim = canEnsureBeforeEmbed ? dimFromEnv : embeddings?.[0]?.length;

    if (!vectorDim || !Number.isFinite(vectorDim)) {
        throw new Error(
            "无法确定向量维度：请在 .env 设置 EMBEDDING_VECTOR_DIM（如 bge-m3 多为 1024），或确保 Embedding 接口返回有效向量"
        );
    }

    if (!canEnsureBeforeEmbed) {
        setPhase("ensure_collection");
        await ensureCollection({
            qdrantUrl,
            collection,
            vectorDim,
            distance
        });
    }

    const visible_department_ids = normalizeVisibleDeptIdsForPayload(visibleDeptIds);
    const kgMeta = graphDocMeta && typeof graphDocMeta === "object" ? graphDocMeta : {};

    const points = chunks.map((c, i) => {
        const chunkIndex = i;
        const preview = buildPayloadTextPreview(c.text);
        const kgPayload = buildKgChunkPayload({
            chunkText: c.text,
            filePathInPayload: filePathInPayload || filePath,
            visibleDeptIds,
            graphDocMeta: kgMeta
        });
        return {
            id: chunkPointUuid(docId, chunkIndex),
            vector: embeddings[i],
            payload: {
                doc_id: docId,
                file_path: filePathInPayload || filePath,
                file_name: fileName,
                ...(docTitleNorm ? { doc_title: docTitleNorm } : {}),
                chunk_index: chunkIndex,
                text_preview: preview,
                content_hash: contentHash,
                content_md5: contentMd5,
                indexed_at: indexedAt,
                visible_department_ids,
                embedding_model_version: embeddingModelVersion,
                char_start: c.charStart,
                char_end: c.charEnd,
                sheet_name: c.sheet_name,
                sheet_index: c.sheet_index,
                row_start: c.row_start,
                row_end: c.row_end,
                page_start: c.page_start,
                page_end: c.page_end,
                slide_index: c.slide_index,
                section_heading: c.section_heading,
                ...kgPayload
            }
        };
    });

    await upsertPoints({
        qdrantUrl,
        collection,
        points
    });

    let kgExtract = null;
    if (isKgExtractEnabled()) {
        setPhase("kg_extract");
        try {
            kgExtract = await extractAndPersistKgForIngest({
                docId,
                chunks,
                graphDocMeta: kgMeta
            });
        } catch (e) {
            kgExtract = {
                skipped: false,
                failed: true,
                error: String((e && e.message) || e).slice(0, 500)
            };
            // eslint-disable-next-line no-console
            console.error("[ingest] kg extract failed", e);
        }
    }

    return {
        skipped: false,
        contentMd5,
        contentHash,
        indexMeta: {
            vectorDim,
            chunkCount: chunks.length,
            embeddingBatchSize: Number.isFinite(embeddingBatchSize) ? embeddingBatchSize : 16,
            chunkSize: chunking.chunkSize,
            chunkOverlap: chunking.chunkOverlap,
            embeddingModel,
            embeddingModelVersion,
            kgExtract
        }
    };
};

module.exports = { ingestSingleTextFile };
