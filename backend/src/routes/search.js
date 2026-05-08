const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const multer = require("multer");

const { searchPostRateLimit } = require("../lib/apiRateLimit");
const { runQueryTsv } = require("../lib/sqlcmd");
const { escapeSql } = require("../lib/auditLog");
const { decodeMultipartFilename } = require("../lib/utf8Filename");
const { sanitizeStorageBasename } = require("../lib/sanitizeStorageFilename");
const { resolveStorageKeyToAbsolute } = require("../lib/storagePaths");
const { extractComparePlainWithPages } = require("../lib/extractPlainText");
const { buildDocumentDiffReport } = require("../lib/documentCompare");
const { summarizeCompareForUser } = require("../lib/compareLlmSummary");
const { buildCompareExcelBuffer, buildCompareDocxBuffer } = require("../lib/compareReportExport");
const { userCanReadDocumentByDeptScope } = require("../lib/documentReadAcl");

const searchRouter = express.Router();

/** 对比接口单文件上限（内存存储，两文件对比时峰值约 2× 该值）；默认 100MB，可用 SEARCH_COMPARE_MAX_FILE_MB 调整，最大 500 */
const compareMaxFileBytes = (() => {
    const n = Number(process.env.SEARCH_COMPARE_MAX_FILE_MB);
    const mb = Number.isFinite(n) && n > 0 ? n : 100;
    return Math.min(Math.floor(mb * 1024 * 1024), 500 * 1024 * 1024);
})();

const compareUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: compareMaxFileBytes }
});

/** 捕获 Multer 体积限制等错误，避免未处理异常返回 500 */
const runCompareUpload = (uploadMiddleware) => (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
        if (!err) {
            next();
            return;
        }
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
            const mb = Math.max(1, Math.round(compareMaxFileBytes / (1024 * 1024)));
            return res.status(413).json({
                code: 413,
                msg: `上传文件过大：对比接口单个文件不超过 ${mb}MB（可在服务端设置环境变量 SEARCH_COMPARE_MAX_FILE_MB）`,
                data: { field: err.field || "" }
            });
        }
        next(err);
    });
};

const parseScrollPoints = (json) => {
    const r = json && json.result;
    if (r && Array.isArray(r.points)) return r.points;
    if (Array.isArray(json?.points)) return json.points;
    return [];
};

const scrollNextOffset = (json) => {
    const r = json && json.result;
    if (r && r.next_page_offset != null) return r.next_page_offset;
    if (json && json.next_page_offset != null) return json.next_page_offset;
    return null;
};

/**
 * 分页 scroll，避免单次 400 条采样漏掉含关键词的块（大库时混合检索关键字分支失效）。
 */
const scrollPointsAccumulated = async ({
    scrollPoints,
    qdrantUrl,
    collection,
    filter,
    batchLimit,
    maxPoints
}) => {
    const out = [];
    let offset;
    const batch = Math.max(50, Math.min(1000, batchLimit));
    const rawHard = Number(process.env.SEARCH_KEYWORD_SCROLL_HARD_CAP);
    const hardCeil =
        Number.isFinite(rawHard) && rawHard >= 1000 ? Math.min(500000, rawHard) : 100000;
    const cap = Math.max(batch, Math.min(hardCeil, Math.max(1, maxPoints)));
    while (out.length < cap) {
        const take = Math.min(batch, cap - out.length);
        // eslint-disable-next-line no-await-in-loop
        const scrollJson = await scrollPoints({
            qdrantUrl,
            collection,
            limit: take,
            filter,
            withPayload: true,
            offset
        });
        const points = parseScrollPoints(scrollJson);
        if (!points.length) break;
        out.push(...points);
        const next = scrollNextOffset(scrollJson);
        if (next == null) break;
        offset = next;
    }
    return out;
};

/** 可选轻量 Rerank（关键词命中数，无额外模型依赖；SEARCH_RERANK_ENABLED=1） */
const maybeKeywordRerank = (hits, queryText, topK) => {
    if (String(process.env.SEARCH_RERANK_ENABLED || "").trim() !== "1") return hits;
    const terms = String(queryText || "")
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1);
    if (!terms.length || !hits.length) return hits;
    const hay = (h) =>
        `${String(h.text_preview || "").toLowerCase()}\n${String(h.file_name || "").toLowerCase()}\n${String(h.doc_title || "").toLowerCase()}\n${String(h.file_path || "").toLowerCase()}\n${String(h.sheet_name || "").toLowerCase()}`;
    return [...hits]
        .sort((a, b) => {
            const ta = hay(a);
            const tb = hay(b);
            const sa = terms.filter((t) => ta.includes(t)).length;
            const sb = terms.filter((t) => tb.includes(t)).length;
            if (sb !== sa) return sb - sa;
            const ba = Number(b.rrfScore ?? b.vectorScore ?? b.score ?? 0);
            const aa = Number(a.rrfScore ?? a.vectorScore ?? a.score ?? 0);
            return ba - aa;
        })
        .slice(0, topK);
};

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ auditSearch?: boolean }} opts — auditSearch：管理员跨部门审计检索（PRD §5.3.3），写入 audit_logs
 */
const {
    extractFileNameHintsFromQuery,
    scrollPointsMatchingFileHints,
    reorderHitsByFileHints,
    buildHitsWithFileScopeFallback
} = require("../lib/searchQueryFileHints");

const performKnowledgeSearch = async (req, res, opts = {}) => {
    const auditSearch = opts.auditSearch === true;
    const body = req.body || {};
    const {
        query,
        topK,
        hybrid,
        includeAnswer,
        includeRag,
        conversationContext,
        includeHits
    } = body;
    /** 默认返回 hits；对接方只要大模型答复时可设 includeHits:false（仍会在服务端用 hits 调 vLLM） */
    const wantHits = includeHits !== false;

    if (!query || typeof query !== "string") {
        return res.status(400).json({
            code: 400,
            msg: "query 参数必填（string）",
            data: {}
        });
    }

    const limit = topK ? Math.max(1, Math.min(50, Number(topK))) : 8;
    const userDeptIds = req.user?.userDeptIds || [];
    /** 显式开启时管理员可走旧版「检索不过滤部门」（与 auditSearch 分离） */
    const adminAclBypass =
        !auditSearch &&
        String(req.user?.role || "").toLowerCase() === "admin" &&
        String(process.env.SEARCH_ADMIN_BYPASS_ACL || "0").trim() === "1";

    const effectiveBypass = auditSearch || adminAclBypass;

    const hybridOn = hybrid !== false;
    const wantAnswer =
        includeAnswer === false
            ? false
            : includeAnswer === true
              ? true
              : includeRag !== false;

    try {
        const { embedTexts } = require("../lib/embeddingClient");
        const {
            ensureCollection,
            searchPoints,
            scrollPoints,
            getCollectionInfo
        } = require("../lib/qdrantRestClient");
        const { hitsFromScrollPoints, mergeHybrid } = require("../lib/hybridSearch");
        const { buildDeptVisibilityFilter, userCanSeePayload } = require("../lib/deptIdsForQdrant");

        const qdrantUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333";
        const collection = process.env.QDRANT_COLLECTION || "kb_chunks";
        const distance = process.env.QDRANT_DISTANCE || "Cosine";

        const vectorPoolMult = process.env.SEARCH_VECTOR_POOL_MULT
            ? Number(process.env.SEARCH_VECTOR_POOL_MULT)
            : 10;
        const scrollLimit = process.env.SEARCH_KEYWORD_SCROLL_LIMIT
            ? Number(process.env.SEARCH_KEYWORD_SCROLL_LIMIT)
            : 400;
        /* 混合检索关键字分支：单次请求内 scroll 点数上限。原默认 25000 在大库上极易拖慢至数十秒并触发前端 30s 超时；可用 SEARCH_KEYWORD_SCROLL_MAX_POINTS 调高以换召回率 */
        const scrollMaxPoints = process.env.SEARCH_KEYWORD_SCROLL_MAX_POINTS
            ? Number(process.env.SEARCH_KEYWORD_SCROLL_MAX_POINTS)
            : 8000;
        const keywordBranch = process.env.SEARCH_KEYWORD_BRANCH
            ? Number(process.env.SEARCH_KEYWORD_BRANCH)
            : 72;
        const rrfK = process.env.SEARCH_RRF_K ? Number(process.env.SEARCH_RRF_K) : 60;

        const vectorTopCap = process.env.SEARCH_VECTOR_TOP_CAP
            ? Number(process.env.SEARCH_VECTOR_TOP_CAP)
            : 128;
        const vectorCap =
            Number.isFinite(vectorTopCap) && vectorTopCap >= 10 ? Math.min(256, vectorTopCap) : 128;
        const fileHints = extractFileNameHintsFromQuery(query);
        // #region agent log
        fetch("http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Debug-Session-Id": "2a0649"
            },
            body: JSON.stringify({
                sessionId: "2a0649",
                runId: "search-pre",
                hypothesisId: "H1",
                location: "search.js:fileHints",
                message: "extracted file name hints",
                data: {
                    hintCount: fileHints.length,
                    fileHints,
                    queryHead: String(query).slice(0, 160)
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion
        const vectorSearchLimit = Math.min(
            fileHints.length ? 256 : vectorCap,
            Math.max(limit * vectorPoolMult, limit, fileHints.length ? limit * 24 : 0)
        );

        let collectionPointsCount = -1;
        try {
            const info = await getCollectionInfo({ qdrantUrl, collection });
            const pc = info?.result?.points_count ?? info?.points_count;
            if (pc != null && Number.isFinite(Number(pc))) collectionPointsCount = Number(pc);
        } catch (_) {
            collectionPointsCount = -1;
        }

        const vectors = await embedTexts([query]);
        const vector = vectors[0];

        if (Array.isArray(vector) && vector.length > 0) {
            await ensureCollection({
                qdrantUrl,
                collection,
                vectorDim: vector.length,
                distance
            });
        }

        const deptFilter = effectiveBypass ? undefined : buildDeptVisibilityFilter(userDeptIds);

        const vecRes = await searchPoints({
            qdrantUrl,
            collection,
            vector,
            limit: vectorSearchLimit,
            filter: deptFilter
        });

        const vecPoints = vecRes?.result || vecRes?.points || [];
        let vectorHits = vecPoints.map((p) => ({
            id: p.id,
            score: p.score,
            ...((p.payload && typeof p.payload === "object") ? p.payload : {})
        }));
        if (fileHints.length) {
            vectorHits = reorderHitsByFileHints(vectorHits, fileHints);
        }

        let hits;
        let scrollHits = [];
        /** scroll 按文件名收窄后的原始点（用于文件级 hits 兜底，避免中英关键词不一致时 vLLM 拿不到正文） */
        let fileScopeNarrowedPoints = null;
        /** debug-2a0649：scroll 与文件名收窄统计 */
        let dbgScrollRaw = 0;
        let dbgNarrowed = 0;
        let dbgSamplePayloads = [];
        let dbgSqlDocIds = [];
        let dbgSqlScroll = 0;

        const scrollCapBase =
            Number.isFinite(scrollMaxPoints) && scrollMaxPoints > 0 ? scrollMaxPoints : 8000;
        const scrollCapEffective = fileHints.length
            ? Math.min(50000, Math.max(scrollCapBase * 3, scrollCapBase))
            : scrollCapBase;

        if (hybridOn && scrollLimit > 0) {
            let scrolled = await scrollPointsAccumulated({
                scrollPoints,
                qdrantUrl,
                collection,
                filter: deptFilter,
                batchLimit: Math.min(1000, Math.max(50, scrollLimit)),
                maxPoints: scrollCapEffective
            });
            dbgScrollRaw = scrolled.length;
            if (fileHints.length) {
                const narrowedScroll = scrollPointsMatchingFileHints(scrolled, fileHints);
                dbgNarrowed = narrowedScroll.length;
                if (narrowedScroll.length === 0 && scrolled.length > 0) {
                    dbgSamplePayloads = scrolled.slice(0, 35).map((p) => {
                        const pl = p && p.payload && typeof p.payload === "object" ? p.payload : {};
                        return {
                            fn: String(pl.file_name || "").slice(0, 96),
                            dt: String(pl.doc_title || "").slice(0, 96),
                            fp: String(pl.file_path || "").slice(-120)
                        };
                    });
                }
                if (narrowedScroll.length > 0) {
                    scrolled = narrowedScroll;
                    fileScopeNarrowedPoints = narrowedScroll;
                } else if (fileHints.length) {
                    try {
                        const { resolveDocIdsByFileHints } = require("../lib/resolveDocIdsByFileHints");
                        const docIds = await resolveDocIdsByFileHints(fileHints);
                        dbgSqlDocIds = docIds.slice(0, 24);
                        if (docIds.length > 0) {
                            const docClause = { key: "doc_id", match: { any: docIds } };
                            const docScopedFilter = deptFilter
                                ? { must: [deptFilter, docClause] }
                                : { must: [docClause] };
                            const sqlScoped = await scrollPointsAccumulated({
                                scrollPoints,
                                qdrantUrl,
                                collection,
                                filter: docScopedFilter,
                                batchLimit: Math.min(1000, Math.max(50, scrollLimit)),
                                maxPoints: Math.min(8000, scrollCapEffective)
                            });
                            dbgSqlScroll = sqlScoped.length;
                            if (sqlScoped.length > 0) {
                                scrolled = sqlScoped;
                                fileScopeNarrowedPoints = sqlScoped;
                                dbgNarrowed = sqlScoped.length;
                            }
                        }
                    } catch (sqlScErr) {
                        // eslint-disable-next-line no-console
                        console.warn("search doc_id scroll by file hints:", sqlScErr);
                    }
                }
            }
            scrollHits = hitsFromScrollPoints(scrolled);
            hits = mergeHybrid({
                vectorHits: vectorHits,
                scrollHits,
                query,
                topK: limit,
                rrfK: Number.isFinite(rrfK) && rrfK > 0 ? rrfK : 60,
                keywordBranchLimit: Number.isFinite(keywordBranch) && keywordBranch > 0 ? keywordBranch : 40
            });
        } else {
            hits = vectorHits.slice(0, limit).map((h) => ({
                ...h,
                retrievalSource: "vector",
                vectorScore: h.score,
                keywordScore: 0
            }));
        }

        const aclFallbackDisabled = String(process.env.SEARCH_ACL_FALLBACK || "1").trim() === "0";
        let aclFallbackUsed = false;
        let fbVectorPoolSize = vectorHits.length;
        let fbKeywordPoolSize = scrollHits.length;

        if (
            !effectiveBypass &&
            !aclFallbackDisabled &&
            hits.length === 0 &&
            userDeptIds.length > 0
        ) {
            try {
                const vecResUf = await searchPoints({
                    qdrantUrl,
                    collection,
                    vector,
                    limit: vectorSearchLimit,
                    filter: undefined
                });
                const vecPointsUf = vecResUf?.result || vecResUf?.points || [];
                const vectorHitsUf = vecPointsUf.map((p) => ({
                    id: p.id,
                    score: p.score,
                    ...((p.payload && typeof p.payload === "object") ? p.payload : {})
                }));

                let mergedUf;
                let scrollHitsUf = [];
                if (hybridOn && scrollLimit > 0) {
                    let scrolledUf = await scrollPointsAccumulated({
                        scrollPoints,
                        qdrantUrl,
                        collection,
                        filter: undefined,
                        batchLimit: Math.min(1000, Math.max(50, scrollLimit)),
                        maxPoints: scrollCapEffective
                    });
                    if (fileHints.length) {
                        const narrowedUf = scrollPointsMatchingFileHints(scrolledUf, fileHints);
                        if (narrowedUf.length > 0) {
                            scrolledUf = narrowedUf;
                        } else {
                            try {
                                const { resolveDocIdsByFileHints } = require("../lib/resolveDocIdsByFileHints");
                                const docIdsUf = await resolveDocIdsByFileHints(fileHints);
                                if (docIdsUf.length > 0) {
                                    const docClauseUf = { key: "doc_id", match: { any: docIdsUf } };
                                    const sqlScopedUf = await scrollPointsAccumulated({
                                        scrollPoints,
                                        qdrantUrl,
                                        collection,
                                        filter: { must: [docClauseUf] },
                                        batchLimit: Math.min(1000, Math.max(50, scrollLimit)),
                                        maxPoints: Math.min(8000, scrollCapEffective)
                                    });
                                    if (sqlScopedUf.length > 0) scrolledUf = sqlScopedUf;
                                }
                            } catch (eUf) {
                                // eslint-disable-next-line no-console
                                console.warn("search acl fallback doc_id scroll:", eUf);
                            }
                        }
                    }
                    scrollHitsUf = hitsFromScrollPoints(scrolledUf);
                    mergedUf = mergeHybrid({
                        vectorHits: vectorHitsUf,
                        scrollHits: scrollHitsUf,
                        query,
                        topK: Math.min(80, Math.max(limit * 6, limit)),
                        rrfK: Number.isFinite(rrfK) && rrfK > 0 ? rrfK : 60,
                        keywordBranchLimit: Math.max(
                            Number.isFinite(keywordBranch) && keywordBranch > 0 ? keywordBranch : 40,
                            60
                        )
                    });
                } else {
                    mergedUf = vectorHitsUf.slice(0, limit).map((h) => ({
                        ...h,
                        retrievalSource: "vector",
                        vectorScore: h.score,
                        keywordScore: 0
                    }));
                }

                const filtered = mergedUf.filter((h) => userCanSeePayload(h, userDeptIds)).slice(0, limit);
                if (filtered.length > 0) {
                    aclFallbackUsed = true;
                    fbVectorPoolSize = vectorHitsUf.length;
                    fbKeywordPoolSize = hybridOn && scrollLimit > 0 ? scrollHitsUf.length : 0;
                    hits = filtered.map((h) => ({
                        ...h,
                        retrievalSource: h.retrievalSource
                            ? `${h.retrievalSource}+acl_fallback`
                            : "acl_fallback"
                    }));
                    scrollHits = scrollHitsUf;
                    vectorHits = vectorHitsUf;
                }
            } catch (fbErr) {
                // eslint-disable-next-line no-console
                console.warn("search acl fallback:", fbErr);
            }
        }

        hits = maybeKeywordRerank(hits, query, limit);
        hits = buildHitsWithFileScopeFallback(hits, fileScopeNarrowedPoints, query, limit);
        if (fileHints.length) {
            hits = reorderHitsByFileHints(hits, fileHints).slice(0, Math.max(limit, 20));
        }

        // #region agent log
        {
            const nameProbe = (arr) =>
                (arr || []).filter((h) =>
                    /lge|乐金/i.test(`${h.file_name || ""}\n${h.file_path || ""}`)
                ).length;
            const scrollCap = scrollCapEffective;
            const topHitsDetail = (hits || []).slice(0, 12).map((h) => ({
                fn: String(h.file_name || "").slice(0, 80),
                dt: String(h.doc_title || "").slice(0, 80),
                rs: String(h.retrievalSource || "").slice(0, 40),
                prev: String(h.text_preview || "").slice(0, 100)
            }));
            const fileScopeCount = (hits || []).filter((h) =>
                String(h.retrievalSource || "").includes("file_scope")
            ).length;
            fetch("http://127.0.0.1:7267/ingest/1ac3dd64-387b-48c9-973e-f2097f200d3a", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Debug-Session-Id": "2a0649"
                },
                body: JSON.stringify({
                    sessionId: "2a0649",
                    runId: "search-post",
                    hypothesisId: "H2-H3-H4-H5",
                    location: "search.js:postRerank",
                    message: "hybrid retrieval + file scope",
                    data: {
                        querySlice: String(query).slice(0, 140),
                        fileHints,
                        collectionPointsCount,
                        scrollMaxPoints: scrollCap,
                        dbgScrollRaw,
                        dbgNarrowed,
                        fileScopeNarrowed: fileScopeNarrowedPoints != null,
                        fileScopeNarrowedLen: fileScopeNarrowedPoints ? fileScopeNarrowedPoints.length : 0,
                        scrollHitsLen: scrollHits.length,
                        scrollCoverage:
                            collectionPointsCount > 0
                                ? Math.round((dbgScrollRaw * 1000) / collectionPointsCount) / 1000
                                : null,
                        vectorSearchLimit,
                        keywordBranch,
                        vectorPool: vectorHits.length,
                        inScrollLgeNameOrPath: nameProbe(scrollHits),
                        inVectorLgeNameOrPath: nameProbe(vectorHits),
                        finalHitsLgeNameOrPath: nameProbe(hits),
                        fileScopeInjectedHits: fileScopeCount,
                        topHitsDetail,
                        dbgSamplePayloadsWhenNarrow0: dbgSamplePayloads,
                        dbgSqlDocIds,
                        dbgSqlScroll
                    },
                    timestamp: Date.now()
                })
            }).catch(() => {});
            try {
                const logPath = path.join(__dirname, "..", "..", "..", "debug-2a0649.log");
                fs.appendFileSync(
                    logPath,
                    `${JSON.stringify({
                        sessionId: "2a0649",
                        runId: "search-post-fs",
                        hypothesisId: "H_SQL_SCOPE",
                        location: "search.js:postRerank:fs",
                        message: "file hint sql scroll fallback",
                        data: {
                            dbgSqlDocIds,
                            dbgSqlScroll,
                            dbgNarrowed,
                            dbgScrollRaw,
                            fileHints
                        },
                        timestamp: Date.now()
                    })}\n`
                );
            } catch (_) {
                /* ignore */
            }
        }
        // #endregion

        try {
            const rate = Number(process.env.AUDIT_SEARCH_SAMPLE_RATE ?? 1);
            const shouldAudit =
                auditSearch ||
                (Number.isFinite(rate) && rate >= 1 ? true : Math.random() < rate);
            if (shouldAudit) {
                const { writeAuditLog } = require("../lib/auditLog");
                void writeAuditLog({
                    actorLoginId: req.user?.loginId || null,
                    action: auditSearch ? "search.audit_query" : "search.query",
                    summary: query.slice(0, 200),
                    metadata: {
                        topK: limit,
                        hitCount: hits.length,
                        hybrid: hybridOn,
                        includeAnswer: wantAnswer,
                        aclFallbackUsed,
                        adminAclBypass,
                        auditSearch: auditSearch || undefined
                    }
                });
            }
        } catch (_) {
            /* ignore */
        }

        let rag = null;
        let ragMeta = null;
        if (wantAnswer && !auditSearch) {
            try {
                const { synthesizeWithVllm, sanitizeConversationContext } = require("../lib/vllmClient");
                rag = await synthesizeWithVllm({
                    query,
                    hits,
                    conversationContext: sanitizeConversationContext(conversationContext)
                });
            } catch (e) {
                const raw = String(e?.message || e || "");
                // eslint-disable-next-line no-console
                console.warn("vLLM degrade:", raw);
                let hint = "大模型服务暂时不可用，请稍后再试或联系管理员。";
                if (raw.includes("Missing VLLM_BASE_URL")) {
                    hint = "后端未配置 VLLM_BASE_URL，无法生成 AI 答复。";
                } else if (raw.includes("timeout") || raw.includes("超时") || raw.includes("abort")) {
                    hint = "大模型请求超时，可稍后重试，或请管理员调大 VLLM_TIMEOUT_SECONDS。";
                } else if (/vLLM error:\s*401\b|vLLM error:\s*403\b/i.test(raw)) {
                    hint = "大模型鉴权失败，请检查 VLLM_API_KEY 与服务端要求是否一致。";
                } else if (/vLLM error:\s*404\b/i.test(raw)) {
                    hint = "大模型接口或模型不存在，请核对 VLLM_BASE_URL、VLLM_MODEL（思考类模型需服务端支持对应 API）。";
                } else if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket/i.test(raw)) {
                    hint = "后端无法连接大模型地址，请检查 VLLM_BASE_URL 网络是否可达、防火墙与端口。";
                }
                ragMeta = { degraded: true, hint, detail: raw.slice(0, 400) };
            }
        }

        if (wantAnswer && rag && !ragMeta && !auditSearch) {
            try {
                const rrate = Number(
                    process.env.AUDIT_RAG_SAMPLE_RATE ?? process.env.AUDIT_SEARCH_SAMPLE_RATE ?? 1
                );
                const shouldRagAudit =
                    Number.isFinite(rrate) && rrate >= 1 ? true : Math.random() < rrate;
                if (shouldRagAudit) {
                    const { writeAuditLog } = require("../lib/auditLog");
                    void writeAuditLog({
                        actorLoginId: req.user?.loginId || null,
                        action: "search.rag_synthesize",
                        summary: query.slice(0, 200),
                        metadata: {
                            topK: limit,
                            hitCount: hits.length,
                            hybrid: hybridOn
                        }
                    });
                }
            } catch (_) {
                /* ignore */
            }
        }

        return res.status(200).json({
            code: 200,
            msg: wantAnswer ? "ok（混合检索，含 AI 答复或已降级）" : "ok",
            data: {
                ...(wantHits ? { hits } : {}),
                hybrid: hybridOn,
                keywordPoolSize: fbKeywordPoolSize,
                vectorPoolSize: fbVectorPoolSize,
                aclFallbackUsed,
                adminAclBypass,
                auditSearch: auditSearch || undefined,
                ...(rag ? { rag } : {}),
                ...(ragMeta ? { ragMeta } : {})
            }
        });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("search error:", e);
        const msg = e?.message || "";
        if (msg.includes("Collection") && msg.includes("doesn't exist")) {
            return res.status(200).json({
                code: 200,
                msg: "ok（无可检索数据）",
                data: { hits: [], hybrid: false }
            });
        }

        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });
    }
};

searchRouter.post("/", (req, res, next) => {
    void searchPostRateLimit(req, res, () =>
        performKnowledgeSearch(req, res, {}).catch(next)
    ).catch(next);
});

const performFileCompare = async (req, res) => {
    const f = req.file;
    if (!f || !Buffer.isBuffer(f.buffer)) {
        return res.status(400).json({ code: 400, msg: "请使用 multipart 上传字段 file", data: {} });
    }

    const originalName = decodeMultipartFilename(
        f.originalname && typeof f.originalname === "string" ? f.originalname : "upload"
    );
    const titleNorm = originalName.trim().slice(0, 255);
    if (!titleNorm) {
        return res.status(400).json({ code: 400, msg: "无效文件名", data: {} });
    }

    const safeTitle = escapeSql(titleNorm);

    const rows = await runQueryTsv(
        `
        SELECT TOP 8
            CONVERT(VARCHAR(36), id),
            REPLACE(REPLACE(REPLACE(ISNULL(title, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
            REPLACE(REPLACE(REPLACE(ISNULL(storage_key, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
            REPLACE(REPLACE(REPLACE(ISNULL(mime_type, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
            REPLACE(REPLACE(REPLACE(ISNULL(CAST(dept_scope_json AS NVARCHAR(MAX)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
        FROM dbo.documents
        WHERE status = N'indexed'
          AND LOWER(LTRIM(RTRIM(title))) = LOWER(LTRIM(N'${safeTitle}'))
        ORDER BY updated_at DESC
        `,
        { variableLengthY: 8000 }
    );

    const candidates = [];
    for (const parts of rows) {
        if (!parts || parts.length < 5) continue;
        candidates.push({
            id: String(parts[0] || "").trim(),
            title: String(parts[1] || "").trim(),
            storageKey: String(parts[2] || "").trim(),
            mimeType: String(parts[3] || "").trim(),
            deptScopeJson: String(parts[4] || "")
        });
    }

    let chosen = null;
    for (const c of candidates) {
        // eslint-disable-next-line no-await-in-loop
        if (await userCanReadDocumentByDeptScope(c.deptScopeJson, req.user)) {
            chosen = c;
            break;
        }
    }

    if (!chosen && candidates.length > 0) {
        return res.status(403).json({
            code: 403,
            msg: "知识库中存在同名已索引文档，但当前账号不在其可检索部门范围内",
            data: { candidateCount: candidates.length, matchedTitle: titleNorm }
        });
    }

    if (!chosen) {
        return res.status(404).json({
            code: 404,
            msg: "未找到与上传文件同名的已索引文档（请确认文档库中标题与文件名一致且状态为已索引）",
            data: { matchedTitle: titleNorm }
        });
    }

    const kbPath = resolveStorageKeyToAbsolute(chosen.storageKey);
    if (!kbPath || !fs.existsSync(kbPath)) {
        return res.status(404).json({
            code: 404,
            msg: "知识库中该文档的存储文件不存在，无法对比",
            data: { documentId: chosen.id }
        });
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-cmp-"));
    const tmpPath = path.join(tmpRoot, sanitizeStorageBasename(originalName));
    fs.writeFileSync(tmpPath, f.buffer);

    let localText = "";
    let kbText = "";
    let localLinePages = [];
    let kbLinePages = [];
    try {
        const loc = await extractComparePlainWithPages({
            filePath: tmpPath,
            mimeType: f.mimetype || "application/octet-stream"
        });
        const kb = await extractComparePlainWithPages({
            filePath: kbPath,
            mimeType: chosen.mimeType || "application/octet-stream"
        });
        localText = loc.text;
        kbText = kb.text;
        localLinePages = loc.linePages;
        kbLinePages = kb.linePages;
    } finally {
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch (_) {
            /* ignore */
        }
    }

    const diff = buildDocumentDiffReport(localText, kbText, {
        matchedTitle: chosen.title,
        kbDocId: chosen.id,
        compareKind: "kb_same",
        diffChangedLine: "对应行内容不同（上传与知识库同一行并排）",
        leftLinePages: localLinePages,
        rightLinePages: kbLinePages
    });

    const llm = await summarizeCompareForUser({
        compareKind: "kb_same",
        matchedTitle: chosen.title,
        uploadFileName: originalName,
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        truncated: diff.truncated,
        diffDetailRows: diff.detailRows,
        pagesLeftStr: diff.pagesLeftStr,
        pagesRightStr: diff.pagesRightStr
    });

    const meta = {
        matchedTitle: chosen.title,
        uploadFileName: originalName,
        kbDocId: chosen.id,
        generatedAt: new Date().toISOString(),
        reportVariant: "kb_same"
    };
    const stats = {
        uploadOnlyLines: diff.removedLines,
        kbOnlyLines: diff.addedLines,
        localCharCount: diff.localCharCount,
        kbCharCount: diff.kbCharCount,
        truncated: diff.truncated,
        pagesLeftStr: diff.pagesLeftStr,
        pagesRightStr: diff.pagesRightStr,
        pagesLeftCount: diff.pagesLeft?.length ?? 0,
        pagesRightCount: diff.pagesRight?.length ?? 0,
        snippetMaxChars: diff.snippetMaxChars
    };

    const llmBlock = [llm.text, llm.hint].filter(Boolean).join("\n\n");

    const excelBuf = buildCompareExcelBuffer(meta, stats, llmBlock, diff.detailRows);
    let docxBuf = Buffer.alloc(0);
    try {
        docxBuf = await buildCompareDocxBuffer(meta, stats, llmBlock, diff.detailRows);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("compare-file docx:", e);
    }

    const UI_ROW_CAP = 600;
    const diffRowsForUi = diff.detailRows.slice(0, UI_ROW_CAP);

    return res.status(200).json({
        code: 200,
        msg: "ok",
        data: {
            compareVariant: "kb_same",
            tableLabels: {
                uploadLine: "上传行号",
                kbLine: "知识库行号",
                uploadTextCol: "上传摘录",
                kbTextCol: "知识库摘录",
                pageUpload: "上传页",
                pageKb: "知识库页"
            },
            matchedDocumentId: chosen.id,
            matchedTitle: chosen.title,
            shortIntro: diff.shortIntro,
            llmExplanation: llm.text || "",
            llmHint: llm.hint || "",
            llmDegraded: !!llm.degraded,
            addedLines: diff.addedLines,
            removedLines: diff.removedLines,
            pairedChangeLines: diff.pairedChangeLines ?? 0,
            pagesLeftStr: diff.pagesLeftStr,
            pagesRightStr: diff.pagesRightStr,
            snippetMaxChars: diff.snippetMaxChars,
            localCharCount: diff.localCharCount,
            kbCharCount: diff.kbCharCount,
            truncated: diff.truncated,
            diffRows: diffRowsForUi,
            diffRowsTotal: diff.detailRows.length,
            diffRowsCapped: diff.detailRows.length > UI_ROW_CAP,
            reportExcelBase64: excelBuf.toString("base64"),
            reportDocxBase64: docxBuf.length ? docxBuf.toString("base64") : ""
        }
    });
};

const performTwoFileCompare = async (req, res) => {
    const fa = req.files?.fileA?.[0];
    const fb = req.files?.fileB?.[0];
    if (!fa || !Buffer.isBuffer(fa.buffer) || !fb || !Buffer.isBuffer(fb.buffer)) {
        return res.status(400).json({
            code: 400,
            msg: "请使用 multipart 同时上传 fileA 与 fileB（各一个文件）",
            data: {}
        });
    }

    const nameA = decodeMultipartFilename(
        fa.originalname && typeof fa.originalname === "string" ? fa.originalname : "文件A"
    );
    const nameB = decodeMultipartFilename(
        fb.originalname && typeof fb.originalname === "string" ? fb.originalname : "文件B"
    );
    const titleA = nameA.trim().slice(0, 255) || "文件A";
    const titleB = nameB.trim().slice(0, 255) || "文件B";

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-cmp2-"));
    const dirA = path.join(tmpRoot, "a");
    const dirB = path.join(tmpRoot, "b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const pathA = path.join(dirA, sanitizeStorageBasename(nameA));
    const pathB = path.join(dirB, sanitizeStorageBasename(nameB));
    fs.writeFileSync(pathA, fa.buffer);
    fs.writeFileSync(pathB, fb.buffer);

    let textA = "";
    let textB = "";
    let linePagesA = [];
    let linePagesB = [];
    try {
        const exA = await extractComparePlainWithPages({
            filePath: pathA,
            mimeType: fa.mimetype || "application/octet-stream"
        });
        const exB = await extractComparePlainWithPages({
            filePath: pathB,
            mimeType: fb.mimetype || "application/octet-stream"
        });
        textA = exA.text;
        textB = exB.text;
        linePagesA = exA.linePages;
        linePagesB = exB.linePages;
    } finally {
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch (_) {
            /* ignore */
        }
    }

    const diff = buildDocumentDiffReport(textA, textB, {
        compareKind: "two_files",
        leftFileName: titleA,
        rightFileName: titleB,
        diffLeftOnlyLine: "仅文件A中有（文件B无对应行）",
        diffRightOnlyLine: "仅文件B中有（文件A无对应行）",
        diffChangedLine: "对应行内容不同（同一行 A 与 B 并排）",
        matchedTitle: `${titleA} ⟷ ${titleB}`,
        kbDocId: "—",
        leftLinePages: linePagesA,
        rightLinePages: linePagesB
    });

    const llm = await summarizeCompareForUser({
        compareKind: "two_files",
        leftFileName: titleA,
        rightFileName: titleB,
        matchedTitle: `${titleA} / ${titleB}`,
        uploadFileName: "",
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        truncated: diff.truncated,
        diffDetailRows: diff.detailRows,
        pagesLeftStr: diff.pagesLeftStr,
        pagesRightStr: diff.pagesRightStr
    });

    const detailColTitles = {
        lineLeft: "文件A行号",
        lineRight: "文件B行号",
        cellLeft: "文件A该行内容",
        cellRight: "文件B该行内容"
    };

    const meta = {
        reportVariant: "two_files",
        leftFileName: titleA,
        rightFileName: titleB,
        matchedTitle: "—",
        uploadFileName: "—",
        kbDocId: "—",
        generatedAt: new Date().toISOString(),
        detailColTitles
    };
    const stats = {
        uploadOnlyLines: diff.removedLines,
        kbOnlyLines: diff.addedLines,
        localCharCount: diff.localCharCount,
        kbCharCount: diff.kbCharCount,
        truncated: diff.truncated,
        pagesLeftStr: diff.pagesLeftStr,
        pagesRightStr: diff.pagesRightStr,
        pagesLeftCount: diff.pagesLeft?.length ?? 0,
        pagesRightCount: diff.pagesRight?.length ?? 0,
        snippetMaxChars: diff.snippetMaxChars
    };

    const llmBlock = [llm.text, llm.hint].filter(Boolean).join("\n\n");

    const excelBuf = buildCompareExcelBuffer(meta, stats, llmBlock, diff.detailRows);
    let docxBuf = Buffer.alloc(0);
    try {
        docxBuf = await buildCompareDocxBuffer(meta, stats, llmBlock, diff.detailRows);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("compare-two-files docx:", e);
    }

    const UI_ROW_CAP = 600;
    const diffRowsForUi = diff.detailRows.slice(0, UI_ROW_CAP);

    const matchedTitleUi = `${titleA} vs ${titleB}`;

    return res.status(200).json({
        code: 200,
        msg: "ok",
        data: {
            compareVariant: "two_files",
            tableLabels: {
                uploadLine: "文件A行号",
                kbLine: "文件B行号",
                uploadTextCol: "文件A摘录",
                kbTextCol: "文件B摘录",
                pageUpload: "文件A页",
                pageKb: "文件B页"
            },
            leftFileName: titleA,
            rightFileName: titleB,
            matchedTitle: matchedTitleUi,
            shortIntro: diff.shortIntro,
            llmExplanation: llm.text || "",
            llmHint: llm.hint || "",
            llmDegraded: !!llm.degraded,
            addedLines: diff.addedLines,
            removedLines: diff.removedLines,
            pairedChangeLines: diff.pairedChangeLines ?? 0,
            pagesLeftStr: diff.pagesLeftStr,
            pagesRightStr: diff.pagesRightStr,
            snippetMaxChars: diff.snippetMaxChars,
            localCharCount: diff.localCharCount,
            kbCharCount: diff.kbCharCount,
            truncated: diff.truncated,
            diffRows: diffRowsForUi,
            diffRowsTotal: diff.detailRows.length,
            diffRowsCapped: diff.detailRows.length > UI_ROW_CAP,
            reportExcelBase64: excelBuf.toString("base64"),
            reportDocxBase64: docxBuf.length ? docxBuf.toString("base64") : ""
        }
    });
};

searchRouter.post(
    "/compare-file",
    runCompareUpload(compareUpload.single("file")),
    (req, res, next) => {
        void searchPostRateLimit(req, res, () =>
            performFileCompare(req, res).catch(next)
        ).catch(next);
    }
);

searchRouter.post(
    "/compare-two-files",
    runCompareUpload(
        compareUpload.fields([
            { name: "fileA", maxCount: 1 },
            { name: "fileB", maxCount: 1 }
        ])
    ),
    (req, res, next) => {
        void searchPostRateLimit(req, res, () =>
            performTwoFileCompare(req, res).catch(next)
        ).catch(next);
    }
);

module.exports = { searchRouter, performKnowledgeSearch };
