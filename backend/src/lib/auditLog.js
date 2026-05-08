const { runQuery } = require("./sqlcmd");

const escapeSql = (s) => String(s).replace(/'/g, "''");

/**
 * @param {object} opts
 * @param {string|null} opts.actorUserId UUID
 * @param {string|null} opts.actorLoginId
 * @param {string} opts.action
 * @param {string|null} opts.targetType
 * @param {string|null} opts.targetId UUID
 * @param {string|null} opts.summary
 * @param {object|null} opts.metadata
 */
const writeAuditLog = async ({
    actorUserId = null,
    actorLoginId = null,
    action,
    targetType = null,
    targetId = null,
    summary = null,
    metadata = null
}) => {
    if (!action) return;
    const metaStr =
        metadata && typeof metadata === "object"
            ? `N'${escapeSql(JSON.stringify(metadata))}'`
            : "NULL";
    const uid =
        actorUserId && typeof actorUserId === "string"
            ? `CAST(N'${escapeSql(actorUserId)}' AS UNIQUEIDENTIFIER)`
            : "NULL";
    const login =
        actorLoginId && typeof actorLoginId === "string"
            ? `N'${escapeSql(actorLoginId)}'`
            : "NULL";
    const tt =
        targetType && typeof targetType === "string"
            ? `N'${escapeSql(targetType)}'`
            : "NULL";
    const tid =
        targetId && typeof targetId === "string"
            ? `CAST(N'${escapeSql(targetId)}' AS UNIQUEIDENTIFIER)`
            : "NULL";
    const sum =
        summary && typeof summary === "string"
            ? `N'${escapeSql(summary.slice(0, 512))}'`
            : "NULL";

    await runQuery(`
        INSERT INTO dbo.audit_logs (
            actor_user_id, actor_login_id, action, target_type, target_id, summary, metadata_json
        )
        VALUES (
            ${uid}, ${login}, N'${escapeSql(action)}', ${tt}, ${tid}, ${sum}, ${metaStr}
        );
    `);
};

module.exports = { writeAuditLog, escapeSql };
