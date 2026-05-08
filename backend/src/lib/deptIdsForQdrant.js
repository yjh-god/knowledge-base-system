/**
 * Qdrant 对 payload 中整数与字符串区分严格；上传常见 [101]（number），
 * JWT 常见 ["101"]（string），会导致 match any 永远不匹配、检索结果为空。
 */

const normalizeVisibleDeptIdsForPayload = (deptIds) => {
    const a = Array.isArray(deptIds) ? deptIds : deptIds == null ? [] : [deptIds];
    return a
        .map((x) => {
            const s = String(x == null ? "" : x).trim();
            if (!s) return null;
            if (s === "*") return "*";
            const n = Number(s);
            if (Number.isFinite(n) && String(n) === s) return n;
            return s;
        })
        .filter((x) => x != null && x !== "");
};

/**
 * 检索过滤：对纯数字部门同时用 int 与 string 匹配，兼容历史点。
 */
const buildDeptVisibilityFilter = (userDeptIds) => {
    const raw = Array.isArray(userDeptIds) ? userDeptIds : [];
    const intSet = new Set();
    const strSet = new Set();
    for (const x of raw) {
        const s = String(x == null ? "" : x).trim();
        if (!s) continue;
        strSet.add(s);
        const n = Number(s);
        if (Number.isFinite(n) && String(n) === s) intSet.add(n);
    }
    const intIds = [...intSet];
    const strIds = [...strSet];
    /** 全公司可见（PRD §5.3.2 特权文档） */
    const should = [{ key: "visible_department_ids", match: { value: "*" } }];
    if (intIds.length) {
        should.push({ key: "visible_department_ids", match: { any: intIds } });
    }
    if (strIds.length) {
        should.push({ key: "visible_department_ids", match: { any: strIds } });
    }
    if (intIds.length === 0 && strIds.length === 0) {
        return { should };
    }
    return { should };
};

/**
 * 应用层部门校验：与 Qdrant filter 逻辑一致，但兼容 int/string 混用（兜底路径用）。
 */
const userCanSeePayload = (payload, userDeptIds) => {
    const vis = payload?.visible_department_ids;
    if (!Array.isArray(vis) || vis.length === 0) return false;
    if (vis.some((v) => String(v).trim() === "*")) return true;

    const raw = Array.isArray(userDeptIds) ? userDeptIds : [];
    if (raw.length === 0) return false;

    const userVariants = new Set();
    for (const u of raw) {
        const s = String(u == null ? "" : u).trim();
        if (!s) continue;
        userVariants.add(s);
        const n = Number(s);
        if (Number.isFinite(n) && String(n) === s) userVariants.add(n);
    }

    for (const v of vis) {
        if (userVariants.has(v)) return true;
        const vs = String(v).trim();
        if (userVariants.has(vs)) return true;
        const vn = typeof v === "number" ? v : Number(vs);
        if (Number.isFinite(vn) && userVariants.has(vn)) return true;
        if (Number.isFinite(vn) && userVariants.has(String(vn))) return true;
    }
    return false;
};

module.exports = {
    normalizeVisibleDeptIdsForPayload,
    buildDeptVisibilityFilter,
    userCanSeePayload
};
