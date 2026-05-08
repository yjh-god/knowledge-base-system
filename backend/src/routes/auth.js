const express = require("express");

const jwt = require("jsonwebtoken");



const { writeAuditLog, escapeSql } = require("../lib/auditLog");

const { runQuery, runQueryTsv } = require("../lib/sqlcmd");

const { verifyPassword, hashPassword } = require("../lib/passwordHash");

const { checkLoginLockout, recordLoginFailure, clearLoginFailures } = require("../lib/loginRateLimit");

const { decodeBearerUser } = require("../middleware/auth");



const authRouter = express.Router();

authRouter.post("/login", async (req, res) => {

    const { loginId, password, userDeptIds, deptIds } = req.body || {};

    if (!loginId || typeof loginId !== "string") {

        return res.status(400).json({ code: 400, msg: "请填写登录 ID", data: {} });

    }

    if (!password || typeof password !== "string") {

        return res.status(400).json({ code: 400, msg: "请填写密码", data: {} });

    }



    const secret = process.env.JWT_SECRET;

    if (!secret) {

        return res.status(500).json({ code: 500, msg: "服务未配置 JWT_SECRET", data: {} });

    }

    const lock = await checkLoginLockout(req);

    if (lock) {

        res.setHeader("Retry-After", String(lock.retryAfterSec));

        return res.status(429).json({

            code: 429,

            msg: `登录尝试过多，请在 ${lock.retryAfterSec} 秒后重试`,

            data: {}

        });

    }

    const devLoginId = process.env.DEV_LOGIN_ID || "admin";

    const devPassword = process.env.DEV_PASSWORD || "";



    let actorUserId = null;

    let userDeptIdList = [];

    let role = "user";

    let authenticated = false;

    const emptyProfile = () => ({
        displayName: "",
        ehrEmpId: "",
        ehrEmpType: "",
        ehrDeptname: "",
        ehrStaname: "",
        ehrJobname: "",
        ehrMobile: ""
    });
    let loginProfile = emptyProfile();

    try {
        const userCells = (
            await runQueryTsv(`
            SELECT TOP 1
                CONVERT(VARCHAR(36), id),
                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(login_id, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(CAST(password_hash AS NVARCHAR(256)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(dept_ids_json, N''), 3900), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(display_name, N''), 255), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_emp_id, N''), 128), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_emp_type, N''), 128), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_deptname, N''), 512), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_staname, N''), 256), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_jobname, N''), 256), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_mobile, N''), 64), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N'')
            FROM dbo.users
            WHERE login_id = N'${escapeSql(loginId)}'
        `)
        )[0];

        const row =
            userCells && userCells[0]
                ? {
                      id: userCells[0],
                      login_id: userCells[1],
                      password_hash: userCells[2],
                      dept_ids_json: userCells[3] || "[]",
                      display_name: userCells[4] || "",
                      ehr_emp_id: userCells[5] || "",
                      ehr_emp_type: userCells[6] || "",
                      ehr_deptname: userCells[7] || "",
                      ehr_staname: userCells[8] || "",
                      ehr_jobname: userCells[9] || "",
                      ehr_mobile: userCells[10] || ""
                  }
                : null;

        if (row && verifyPassword(password, row.password_hash)) {
            authenticated = true;
            actorUserId = row.id;
            try {
                userDeptIdList = JSON.parse(row.dept_ids_json || "[]");
            } catch (_) {
                userDeptIdList = [];
            }
            if (!Array.isArray(userDeptIdList)) userDeptIdList = [];
            const adminIds = (process.env.ADMIN_LOGIN_IDS || process.env.DEV_LOGIN_ID || "admin")
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
            role = adminIds.includes(loginId) ? "admin" : "user";
            loginProfile = {
                displayName: row.display_name || "",
                ehrEmpId: row.ehr_emp_id || "",
                ehrEmpType: row.ehr_emp_type || "",
                ehrDeptname: row.ehr_deptname || "",
                ehrStaname: row.ehr_staname || "",
                ehrJobname: row.ehr_jobname || "",
                ehrMobile: row.ehr_mobile || ""
            };
        }
    } catch (_) {
        /* 无 users 表或查询失败时走下方 dev 账号 */
    }



    if (!authenticated) {

        if (loginId === devLoginId && devPassword && password === devPassword) {

            authenticated = true;

            if (Array.isArray(userDeptIds)) {

                userDeptIdList = userDeptIds.map((x) => String(x)).filter(Boolean);

            } else if (Array.isArray(deptIds)) {

                userDeptIdList = deptIds.map((x) => String(x)).filter(Boolean);

            } else {

                const deptRaw = process.env.DEV_USER_DEPT_IDS || "101";

                userDeptIdList = deptRaw

                    .split(",")

                    .map((x) => x.trim())

                    .filter(Boolean);

            }

            role = "admin";
            loginProfile = {
                displayName: "开发账号",
                ehrEmpId: "",
                ehrEmpType: "",
                ehrDeptname: "由服务器 DEV_USER_DEPT_IDS 配置（非 EHR 同步用户）",
                ehrStaname: "",
                ehrJobname: "",
                ehrMobile: ""
            };
        }
    }

    if (!authenticated) {

        await recordLoginFailure(req);

        return res.status(401).json({
            code: 401,
            msg: "账号不存在或密码错误，请核对登录 ID 与密码",
            data: {}
        });

    }

    await clearLoginFailures(req);

    try {

        await writeAuditLog({

            actorUserId,

            actorLoginId: loginId,

            action: "auth.login",

            summary: "登录成功",

            metadata: { ip: req.ip || "" }

        });

    } catch (_) {

        /* 审计失败不阻塞登录 */

    }



    const payload = {
        loginId,
        role,
        userDeptIds: userDeptIdList,
        displayName: loginProfile.displayName,
        ehrEmpId: loginProfile.ehrEmpId,
        ehrEmpType: loginProfile.ehrEmpType,
        ehrDeptname: loginProfile.ehrDeptname,
        ehrStaname: loginProfile.ehrStaname,
        ehrJobname: loginProfile.ehrJobname,
        ehrMobile: loginProfile.ehrMobile
    };

    const expiresIn = process.env.JWT_EXPIRES_IN || "8h";
    const token = jwt.sign(payload, secret, { expiresIn });

    return res.status(200).json({
        code: 200,
        msg: "ok",
        data: { token, role, profile: loginProfile }
    });

});



/** 修改密码（本地 users 表账号） */

authRouter.post("/change-password", async (req, res) => {

    let session;

    try {

        session = decodeBearerUser(req);

    } catch (e) {

        const code = e?.message === "NO_SECRET" ? 500 : 401;

        return res.status(code).json({

            code,

            msg: code === 401 ? "未登录或 Token 无效" : "服务未配置 JWT_SECRET",

            data: {}

        });

    }



    const { oldPassword, newPassword } = req.body || {};

    if (!oldPassword || typeof oldPassword !== "string" || !newPassword || typeof newPassword !== "string") {

        return res.status(400).json({ code: 400, msg: "oldPassword/newPassword 必填", data: {} });

    }

    if (newPassword.length < 3) {

        return res.status(400).json({ code: 400, msg: "新密码过短", data: {} });

    }



    try {

        const pwdCells = (

            await runQueryTsv(`

            SELECT TOP 1

                CONVERT(VARCHAR(36), id),

                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(CAST(password_hash AS NVARCHAR(256)), N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N'')

            FROM dbo.users

            WHERE login_id = N'${escapeSql(session.loginId)}'

        `)

        )[0];

        const row =

            pwdCells && pwdCells[0] ? { id: pwdCells[0], password_hash: pwdCells[1] } : null;

        if (!row) {

            return res.status(400).json({

                code: 400,

                msg: "当前会话无本地用户记录（如开发账号），无法在此改密",

                data: {}

            });

        }

        if (!verifyPassword(oldPassword, row.password_hash)) {

            return res.status(401).json({ code: 401, msg: "旧密码错误", data: {} });

        }

        const nextHash = await hashPassword(String(newPassword));

        await runQuery(`

            UPDATE dbo.users

            SET password_hash = N'${escapeSql(nextHash)}',

                password_changed_at = SYSDATETIMEOFFSET(),

                must_change_password = 0

            WHERE id = CAST(N'${escapeSql(row.id)}' AS UNIQUEIDENTIFIER);

        `);

        await writeAuditLog({

            actorUserId: row.id,

            actorLoginId: session.loginId,

            action: "auth.password_change",

            targetType: "user",

            targetId: row.id,

            summary: "用户修改密码"

        });

        return res.status(200).json({ code: 200, msg: "密码已更新", data: {} });

    } catch (e) {

        // eslint-disable-next-line no-console

        console.error("change-password:", e);

        return res.status(500).json({ code: 500, msg: "服务器错误", data: {} });

    }

});



module.exports = { authRouter };


