const { runQueryTsv } = require("./sqlcmd");

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const normId = (s) => String(s || "").trim().toLowerCase();

/**
 * 从 departments 表构建「父 ehr_dept_id → 子行」邻接（子行的 parent_ehr_dept_id 指向父的 ehr_dept_id）。
 */
const buildGraphFromRows = (rows) => {
    const byId = new Map();
    const childrenByParentEhr = new Map();

    for (const c of rows) {
        const id = normId(c[0]);
        const ehr = String(c[1] || "").trim();
        const parentEhr = String(c[2] || "").trim() || null;
        const row = { id, ehrDeptId: ehr, parentEhrDeptId: parentEhr };
        if (!id || !ehr) continue;
        byId.set(id, row);
    }

    for (const row of byId.values()) {
        const p = row.parentEhrDeptId;
        if (!p) continue;
        if (!childrenByParentEhr.has(p)) childrenByParentEhr.set(p, []);
        childrenByParentEhr.get(p).push(row);
    }

    return { byId, childrenByParentEhr };
};

const collectDescendantInternalIds = (rootRow, childrenByParentEhr) => {
    const out = new Set();
    const queue = [rootRow];
    while (queue.length) {
        const r = queue.shift();
        if (!r || out.has(r.id)) continue;
        out.add(r.id);
        const kids = childrenByParentEhr.get(r.ehrDeptId) || [];
        for (const ch of kids) queue.push(ch);
    }
    return out;
};

/**
 * PRD §5.3.2：按节点展开 visible 部门 UUID（内部 id），含下级时递归子部门。
 * @param {Array<{ dept_id: string, include_children?: boolean }>} nodes
 * @returns {Promise<string[]>} 去重后的部门 UUID（小写）
 */
const expandVisibleDeptIdsForIngest = async (nodes) => {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];

    let stdout;
    try {
        stdout = await runQueryTsv(
            `
            SELECT
                CONVERT(VARCHAR(36), id),
                REPLACE(REPLACE(REPLACE(ISNULL(CAST(ehr_dept_id AS NVARCHAR(200)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '),
                REPLACE(REPLACE(REPLACE(ISNULL(CAST(parent_ehr_dept_id AS NVARCHAR(200)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' ')
            FROM dbo.departments
            WHERE is_deleted = 0;
            `,
            { variableLengthY: 4000 }
        );
    } catch (_) {
        return nodes
            .map((n) => normId(n.dept_id))
            .filter((id) => UUID_RE.test(id));
    }

    const lines = String(stdout || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const rows = [];
    for (const line of lines) {
        const parts = line.split("\t");
        if (parts.length >= 2) rows.push(parts);
    }

    if (rows.length === 0) {
        return nodes
            .map((n) => normId(n.dept_id))
            .filter((id) => UUID_RE.test(id));
    }

    const { byId, childrenByParentEhr } = buildGraphFromRows(rows);
    const expanded = new Set();

    for (const n of nodes) {
        const id = normId(n.dept_id);
        if (!UUID_RE.test(id)) continue;
        const row = byId.get(id);
        if (!row) {
            expanded.add(id);
            continue;
        }
        expanded.add(row.id);
        if (n.include_children) {
            for (const x of collectDescendantInternalIds(row, childrenByParentEhr)) {
                expanded.add(x);
            }
        }
    }

    return [...expanded].filter((x) => UUID_RE.test(x));
};

module.exports = { expandVisibleDeptIdsForIngest, UUID_RE };
