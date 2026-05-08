/**
 * 混合检索：向量候选 + 部门过滤下 scroll 的关键字排序候选，RRF 融合。
 * 不依赖 Qdrant 全文索引，适合现有 text_preview 入库字段。
 */

const stablePointId = (hit) => String(hit && hit.id != null ? hit.id : "");

const tokenizeQuery = (query) => {
    const tokens = new Set();
    const s = String(query || "").trim();
    if (!s) return [];

    const add = (t) => {
        const x = String(t).toLowerCase().trim();
        if (x.length >= 2) tokens.add(x);
    };

    const eng = s.match(/[a-zA-Z][a-zA-Z0-9_.-]*/g) || [];
    eng.forEach((w) => add(w));

    const cjkRuns = s.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of cjkRuns) {
        add(run);
        const maxLen = run.length > 36 ? 2 : Math.min(4, run.length);
        for (let len = 2; len <= maxLen; len++) {
            for (let i = 0; i <= run.length - len; i++) {
                add(run.slice(i, i + len));
            }
        }
    }

    return [...tokens];
};

const keywordPayloadScore = (hit, tokens) => {
    const preview = String(hit.text_preview || "").toLowerCase();
    const fname = String(hit.file_name || "").toLowerCase();
    const dtitle = String(hit.doc_title || "").toLowerCase();
    const fpath = String(hit.file_path || "").toLowerCase();
    const sheet = String(hit.sheet_name || "").toLowerCase();
    if (
        !tokens.length ||
        (!preview.trim() &&
            !fname.trim() &&
            !dtitle.trim() &&
            !fpath.trim() &&
            !sheet.trim())
    )
        return 0;
    const nameW = Number(process.env.SEARCH_KEYWORD_FILENAME_WEIGHT);
    const fnameBoost = Number.isFinite(nameW) && nameW >= 1 ? nameW : 3;
    const pathBoost = Math.max(2, fnameBoost - 1);
    let score = 0;
    for (const t of tokens) {
        const base = 1 + Math.min(4, Math.floor(t.length / 2));
        if (fname.includes(t)) score += base * fnameBoost;
        else if (dtitle.includes(t)) score += base * fnameBoost;
        else if (fpath.includes(t)) score += base * pathBoost;
        else if (sheet && sheet.includes(t)) score += base * Math.max(2, fnameBoost - 1);
        else if (preview.includes(t)) score += base;
    }
    return score;
};

const hitsFromScrollPoints = (points) =>
    (points || []).map((p) => ({
        id: p.id,
        score: p.score,
        ...((p.payload && typeof p.payload === "object") ? p.payload : {})
    }));

/**
 * @param {object} opts
 * @param {Array} opts.vectorHits - Qdrant 向量检索结果（已展开 payload）
 * @param {Array} opts.scrollHits - scroll 得到的点（已展开 payload）
 * @param {string} opts.query
 * @param {number} opts.topK
 * @param {number} [opts.rrfK]
 * @param {number} [opts.keywordBranchLimit] - 参与 RRF 的关键字分支条数上限
 */
const mergeHybrid = ({
    vectorHits,
    scrollHits,
    query,
    topK,
    rrfK = 60,
    keywordBranchLimit = 40
}) => {
    const tokens = tokenizeQuery(query);
    const vecList = (vectorHits || []).map((h) => ({ ...h }));

    if (!scrollHits || scrollHits.length === 0 || tokens.length === 0) {
        return vecList.slice(0, topK).map((h) => ({
            ...h,
            retrievalSource: "vector",
            keywordScore: keywordPayloadScore(h, tokens)
        }));
    }

    const kwScored = scrollHits
        .map((h) => ({ ...h, _kw: keywordPayloadScore(h, tokens) }))
        .filter((h) => h._kw > 0)
        .sort((a, b) => b._kw - a._kw)
        .slice(0, keywordBranchLimit)
        .map(({ _kw, ...rest }) => ({ ...rest, keywordScore: _kw, score: 0 }));

    const byId = new Map();
    const bump = (hit, rank, tag) => {
        const id = stablePointId(hit);
        if (!id) return;
        if (!byId.has(id)) {
            byId.set(id, {
                hit: { ...hit },
                rrf: 0,
                tags: new Set(),
                kw: 0,
                vectorScore: null
            });
        }
        const e = byId.get(id);
        e.rrf += 1 / (rrfK + rank + 1);
        e.tags.add(tag);
        if (tag === "vector") {
            const vs = Number(hit.score);
            if (Number.isFinite(vs)) e.vectorScore = e.vectorScore == null ? vs : Math.max(e.vectorScore, vs);
            e.hit = { ...hit, ...e.hit };
        }
        if (tag === "keyword") {
            const k = Number(hit.keywordScore) || 0;
            e.kw = Math.max(e.kw, k);
            e.hit = { ...hit, ...e.hit };
        }
    };

    vecList.forEach((h, i) => bump(h, i, "vector"));
    kwScored.forEach((h, i) => bump(h, i, "keyword"));

    const merged = [...byId.values()]
        .sort((a, b) => b.rrf - a.rrf)
        .slice(0, topK)
        .map((e) => {
            const tags = e.tags;
            const retrievalSource =
                tags.has("vector") && tags.has("keyword")
                    ? "hybrid"
                    : tags.has("keyword")
                      ? "keyword"
                      : "vector";
            const keywordScore = e.kw || keywordPayloadScore(e.hit, tokens);
            return {
                ...e.hit,
                score: Math.round(e.rrf * 1000) / 1000,
                rrfScore: e.rrf,
                vectorScore: e.vectorScore,
                keywordScore,
                retrievalSource
            };
        });

    return merged;
};

module.exports = {
    tokenizeQuery,
    keywordPayloadScore,
    hitsFromScrollPoints,
    mergeHybrid
};
