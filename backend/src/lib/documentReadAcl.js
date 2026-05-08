/**
 * 与 documents.dept_scope_json 一致的可读性判断（对比「按文件名找知识库文档」时用）。
 */

const { expandVisibleDeptIdsForIngest } = require("./deptScopeExpand");

/**
 * @param {string} deptScopeJson
 * @param {object} [user]
 * @returns {Promise<boolean>}
 */
const userCanReadDocumentByDeptScope = async (deptScopeJson, user) => {
    const adminBypass =
        String(user?.role || "").toLowerCase() === "admin" &&
        String(process.env.SEARCH_ADMIN_BYPASS_ACL || "0").trim() === "1";
    if (adminBypass) return true;

    let obj = null;
    try {
        obj = JSON.parse(String(deptScopeJson || "{}"));
    } catch {
        return false;
    }

    if (obj && obj.is_company_wide === true) return true;

    const nodes = Array.isArray(obj?.nodes) ? obj.nodes : [];
    if (nodes.length === 0) return false;

    const rawUser = Array.isArray(user?.userDeptIds) ? user.userDeptIds : [];
    const userIds = new Set(
        rawUser
            .map((x) => String(x == null ? "" : x).trim().toLowerCase())
            .filter(Boolean)
    );
    if (userIds.size === 0) return false;

    let expanded = [];
    try {
        expanded = await expandVisibleDeptIdsForIngest(nodes);
    } catch {
        expanded = nodes
            .map((n) => String(n?.dept_id || "").trim().toLowerCase())
            .filter(Boolean);
    }

    for (const id of expanded) {
        if (userIds.has(String(id).trim().toLowerCase())) return true;
    }
    return false;
};

module.exports = {
    userCanReadDocumentByDeptScope
};
