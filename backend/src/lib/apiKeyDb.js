const crypto = require("crypto");

const { runQuery, runQueryTsv } = require("./sqlcmd");

const { escapeSql } = require("./auditLog");



const hashKey = (apiKey) => crypto.createHash("sha256").update(String(apiKey), "utf8").digest("hex");



const resolveApiKeyFromDb = async (apiKey) => {

    const hash = hashKey(apiKey);

    try {

        const tsv = await runQueryTsv(`

            SELECT TOP 1

                CONVERT(VARCHAR(36), k.id),

                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(u.login_id, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),

                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(u.dept_ids_json, N''), 3900), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N'')

            FROM dbo.api_keys k

            INNER JOIN dbo.users u ON u.id = k.bound_user_id

            WHERE k.revoked_at IS NULL AND k.key_hash = N'${escapeSql(hash)}'

        `);

        const cells = tsv[0];

        if (!cells || !cells[0]) return null;

        const row = { keyId: cells[0], loginId: cells[1] || "", deptIdsJson: cells[2] || "[]" };



        let userDeptIds = [];

        try {

            userDeptIds = JSON.parse(row.deptIdsJson || "[]");

        } catch (_) {

            userDeptIds = [];

        }

        if (!Array.isArray(userDeptIds)) userDeptIds = [];



        void runQuery(`

            UPDATE dbo.api_keys SET last_used_at = SYSDATETIMEOFFSET() WHERE id = CAST(N'${escapeSql(row.keyId)}' AS UNIQUEIDENTIFIER);

        `).catch(() => {});



        return {

            loginId: `api_key:${row.loginId || "svc"}`,

            role: "service",

            userDeptIds: userDeptIds.map(String),

            _apiKeyId: row.keyId

        };

    } catch (_) {

        return null;

    }

};



module.exports = { resolveApiKeyFromDb, hashKey };


