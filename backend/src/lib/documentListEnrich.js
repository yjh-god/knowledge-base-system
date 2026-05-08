const { runQueryTsv } = require("./sqlcmd");

const parseDeptScope = (jsonStr) => {
    try {
        const o = JSON.parse(jsonStr || "{}");
        if (o && o.is_company_wide === true) {
            return { companyWide: true, ids: [] };
        }
        const nodes = o?.nodes;
        if (!Array.isArray(nodes)) return { companyWide: false, ids: [] };
        const ids = nodes.map((n) => String(n?.dept_id ?? "").trim()).filter(Boolean);
        return { companyWide: false, ids };
    } catch {
        return { companyWide: false, ids: [] };
    }
};

const loadDeptIdToNameMap = async () => {
    const rows = await runQueryTsv(
        `
        SELECT
            LOWER(CONVERT(VARCHAR(36), id)),
            REPLACE(REPLACE(REPLACE(ISNULL(name, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
        FROM dbo.departments
        WHERE is_deleted = 0;
        `,
        { variableLengthY: 512 }
    );
    const m = new Map();
    for (const c of rows) {
        const id = (c[0] || "").trim();
        if (!id) continue;
        const name = (c[1] || "").trim() || id;
        m.set(id, name);
    }
    return m;
};

const visibleDeptLabelsFromScope = (deptScopeJson, nameMap) => {
    const { companyWide, ids } = parseDeptScope(deptScopeJson);
    if (companyWide) return "全公司";
    if (!ids.length) return "";
    return ids.map((id) => nameMap.get(String(id).toLowerCase()) || id).join("、");
};

/**
 * 文件类属部门展示：优先 category_nodes / category_is_company_wide；
 * 旧数据或未写入 category_* 时与可检索部门一致（与上传「类属与可检索相同」语义一致）。
 */
const categoryDeptLabelsFromScope = (deptScopeJson, nameMap) => {
    let o;
    try {
        o = JSON.parse(String(deptScopeJson || "{}"));
    } catch {
        return visibleDeptLabelsFromScope(deptScopeJson, nameMap);
    }
    if (o && o.category_is_company_wide === true) return "全公司";
    const catNodes = o?.category_nodes;
    if (Array.isArray(catNodes) && catNodes.length > 0) {
        const ids = catNodes.map((n) => String(n?.dept_id ?? "").trim()).filter(Boolean);
        if (ids.length) {
            return ids.map((id) => nameMap.get(String(id).toLowerCase()) || id).join("、");
        }
    }
    return visibleDeptLabelsFromScope(deptScopeJson, nameMap);
};

/**
 * @param {Array<Record<string, unknown>>} items — 须含 deptScopeJsonRaw
 */
const enrichDocumentListItems = async (items) => {
    let nameMap;
    try {
        nameMap = await loadDeptIdToNameMap();
    } catch {
        nameMap = new Map();
    }
    return items.map((row) => {
        const { deptScopeJsonRaw = "", ...rest } = row;
        const raw = String(deptScopeJsonRaw);
        const { companyWide, ids } = parseDeptScope(raw);
        const labels = visibleDeptLabelsFromScope(raw, nameMap);
        const categoryLabels = categoryDeptLabelsFromScope(raw, nameMap);
        return {
            ...rest,
            visibleDeptLabels: labels,
            categoryDeptLabels: categoryLabels,
            visibleDeptIds: companyWide ? [] : ids,
            deptScopeCompanyWide: companyWide
        };
    });
};

module.exports = {
    enrichDocumentListItems,
    parseDeptScope,
    loadDeptIdToNameMap,
    visibleDeptLabelsFromScope,
    categoryDeptLabelsFromScope
};
