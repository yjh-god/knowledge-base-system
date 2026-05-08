/**
 * 从自然语言问句中提取「疑似文件名 / 文件编号」，用于检索时收窄 Qdrant 过滤条件，
 * 避免全库语义相近的审核问题点 xlsx 淹没目标报告。
 */

/**
 * @param {string} query
 * @returns {string[]} 按长度降序，最多 5 条，已去重
 */
const extractFileNameHintsFromQuery = (query) => {
    const s = String(query || "").trim();
    if (!s) return [];

    const hints = new Set();

    const extRe =
        /([\S\u4e00-\u9fff]{2,}\.(?:xlsx|xlsm|xls|pdf|docx|doc|pptx|md|txt))(?:\b|$)/gi;
    let m;
    while ((m = extRe.exec(s)) !== null) {
        const raw = m[1].replace(/[，。；;、]+$/g, "").trim();
        if (raw.length >= 4) hints.add(raw);
        const noParen = raw
            .replace(/[（(]\s*\d+\s*[）)]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        if (noParen.length >= 4 && noParen !== raw) hints.add(noParen);
    }

    const codeRe =
        /\b([A-Z]{2,4}-[A-Z]{2,4}-[A-Z]{2,4}-\d{2,3}[A-Z]?-\d{2,3}[A-Z]?)\b/i;
    const cm = s.match(codeRe);
    if (cm) hints.add(cm[1]);

    return [...hints]
        .filter((h) => String(h).trim().length >= 4)
        .sort((a, b) => String(b).length - String(a).length)
        .slice(0, 5);
};

/**
 * 内存判断：payload.file_name / doc_title / file_path 是否命中任一 hint（大小写不敏感，子串）
 * @param {object} payload
 * @param {string[]} hints
 */
const payloadFileNameMatchesHints = (payload, hints) => {
    const list = Array.isArray(hints) ? hints.map((h) => String(h || "").trim()).filter(Boolean) : [];
    if (!list.length) return false;
    const fn = String(payload?.file_name || "").toLowerCase();
    const dt = String(payload?.doc_title || "").toLowerCase();
    const fp = String(payload?.file_path || "").toLowerCase();
    if (!fn && !dt && !fp) return false;
    return list.some((h) => {
        const hl = String(h).toLowerCase();
        return (
            (fn && fn.includes(hl)) ||
            (dt && dt.includes(hl)) ||
            (fp && fp.includes(hl))
        );
    });
};

/**
 * scroll / 向量结果中的点：{ id, payload?, ... }
 */
const scrollPointsMatchingFileHints = (points, hints) => {
    const list = Array.isArray(hints) ? hints.map((h) => String(h || "").trim()).filter(Boolean) : [];
    if (!list.length || !Array.isArray(points)) return [];
    return points.filter((p) => {
        const pl = p && typeof p === "object" ? p.payload : null;
        return pl && payloadFileNameMatchesHints(pl, list);
    });
};

const reorderHitsByFileHints = (hits, hints) => {
    const list = Array.isArray(hints) ? hints.map((h) => String(h || "").trim()).filter(Boolean) : [];
    if (!list.length || !Array.isArray(hits) || !hits.length) return hits;
    const score = (h) => (payloadFileNameMatchesHints(h, list) ? 1 : 0);
    return [...hits].sort((a, b) => score(b) - score(a));
};

/**
 * 问句已锁定到少量文件（scroll 已收窄）时，避免「关键词与正文语言不一致」导致 mergeHybrid
 * 关键字分支全空、仅靠向量仍排不进前 10。将目标文件内块按相关性排序后置于 hits 最前（vLLM 只读前 10 条）。
 *
 * @param {Array} hits — 混合检索结果
 * @param {Array<{ id: unknown, payload?: object }> | null} narrowedPoints — scroll 收窄后的原始点
 * @param {string} query
 * @param {number} limit — 接口 topK
 */
const buildHitsWithFileScopeFallback = (hits, narrowedPoints, query, limit) => {
    if (!narrowedPoints || !Array.isArray(narrowedPoints) || narrowedPoints.length === 0) {
        return hits;
    }
    const { hitsFromScrollPoints, tokenizeQuery, keywordPayloadScore } = require("./hybridSearch");
    const q = String(query || "");
    const tok = tokenizeQuery(q);
    const hay = (h) =>
        `${String(h.text_preview || "").toLowerCase()}\n${String(h.sheet_name || "").toLowerCase()}`;

    const topicBoost = (h) => {
        const s = hay(h);
        let b = 0;
        if (/斜坡|坡度|倾角|斜台/i.test(q)) {
            if (/斜坡|坡度|倾角|斜台|slope|tilt|incline/i.test(s)) b += 8;
        }
        if (/跌落|drop/i.test(q) && /跌落|drop|free\s*fall/i.test(s)) b += 6;
        if (/老化|aging/i.test(q) && /老化|aging/i.test(s)) b += 6;
        return b;
    };

    let injected = hitsFromScrollPoints(narrowedPoints).map((h) => ({
        ...h,
        _kw: keywordPayloadScore(h, tok) + topicBoost(h)
    }));
    injected.sort((a, b) => {
        if (b._kw !== a._kw) return b._kw - a._kw;
        return 0;
    });
    injected = injected.map(({ _kw, ...rest }) => ({
        ...rest,
        retrievalSource: rest.retrievalSource
            ? `${rest.retrievalSource}+file_scope`
            : "file_scope"
    }));

    const cap = Math.min(32, Math.max(12, (limit || 8) * 3, narrowedPoints.length));
    const seen = new Set();
    const out = [];
    for (const h of injected) {
        if (out.length >= cap) break;
        const id = String(h.id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(h);
    }
    for (const h of hits || []) {
        if (out.length >= cap) break;
        const id = String(h.id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(h);
    }
    return out;
};

module.exports = {
    extractFileNameHintsFromQuery,
    payloadFileNameMatchesHints,
    scrollPointsMatchingFileHints,
    reorderHitsByFileHints,
    buildHitsWithFileScopeFallback
};
