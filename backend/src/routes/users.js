const express = require("express");
const { escapeSql } = require("../lib/auditLog");
const { runQueryTsv } = require("../lib/sqlcmd");

const usersRouter = express.Router();

const isServiceLogin = (loginId) => !loginId || String(loginId).startsWith("api_key:");

/** 当前登录用户档案（数据库最新，与 JWT 互补） */
usersRouter.get("/me", async (req, res) => {
    const loginId = req.user?.loginId;
    if (isServiceLogin(loginId)) {
        return res.status(200).json({
            code: 200,
            msg: "ok",
            data: {
                id: null,
                loginId: loginId || "",
                displayName: "",
                role: req.user?.role || "",
                ehrEmpId: "",
                ehrEmpType: "",
                ehrDeptname: "",
                ehrStaname: "",
                ehrJobname: "",
                ehrMobile: ""
            }
        });
    }
    try {
        const batch = await runQueryTsv(`
            SELECT TOP 1
                CONVERT(VARCHAR(36), id),
                ISNULL(REPLACE(REPLACE(REPLACE(ISNULL(login_id, N''), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(display_name, N''), 255), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_emp_id, N''), 128), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_emp_type, N''), 128), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_deptname, N''), 512), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_staname, N''), 256), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_jobname, N''), 256), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N''),
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_mobile, N''), 64), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N'')
            FROM dbo.users
            WHERE login_id = N'${escapeSql(loginId)}'
        `);
        const cells = batch && batch[0] ? batch[0] : null;
        if (!cells || !cells[0]) {
            return res.status(200).json({
                code: 200,
                msg: "ok",
                data: {
                    id: null,
                    loginId,
                    displayName: "",
                    role: req.user?.role || "",
                    ehrEmpId: "",
                    ehrEmpType: "",
                    ehrDeptname: "",
                    ehrStaname: "",
                    ehrJobname: "",
                    ehrMobile: ""
                }
            });
        }
        return res.status(200).json({
            code: 200,
            msg: "ok",
            data: {
                id: cells[0],
                loginId: cells[1] || loginId,
                displayName: cells[2] || "",
                role: req.user?.role || "",
                ehrEmpId: cells[3] || "",
                ehrEmpType: cells[4] || "",
                ehrDeptname: cells[5] || "",
                ehrStaname: cells[6] || "",
                ehrJobname: cells[7] || "",
                ehrMobile: cells[8] || ""
            }
        });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("users/me:", e);
        return res.status(500).json({ code: 500, msg: "读取用户信息失败", data: {} });
    }
});

/**
 * 抓拍头像：{AVATAR_CAP_PIC_BASE_URL}/Cap_{ehr_emp_id}.jpg
 * 例：http://<YOUR_INTRANET_HOST>:8080/v8filesvr/CapPic/Cap_12345.jpg（12345 = users.ehr_emp_id）
 */
usersRouter.get("/avatar", async (req, res) => {
    const loginId = req.user?.loginId;
    const baseRaw = String(process.env.AVATAR_CAP_PIC_BASE_URL || "").trim();
    if (isServiceLogin(loginId) || !baseRaw) {
        return res.status(200).json({ code: 200, msg: "ok", data: { avatarUrl: "" } });
    }
    try {
        const batch = await runQueryTsv(`
            SELECT TOP 1
                ISNULL(REPLACE(REPLACE(REPLACE(LEFT(ISNULL(ehr_emp_id, N''), 128), CHAR(9), N' '), CHAR(10), N' '), CHAR(13), N' '), N'')
            FROM dbo.users
            WHERE login_id = N'${escapeSql(loginId)}'
        `);
        const cells = batch && batch[0] ? batch[0] : null;
        let empid = cells && cells[0] ? String(cells[0]).trim() : "";
        empid = empid.replace(/[/\\?#]/g, "");
        if (!empid) {
            return res.status(200).json({ code: 200, msg: "ok", data: { avatarUrl: "" } });
        }
        const base = baseRaw.replace(/\/+$/, "");
        // 与文件服务器文件名一致：Cap_<ehr_emp_id>.jpg（不做 encodeURIComponent，避免与实存文件名不一致）
        const avatarUrl = `${base}/Cap_${empid}.jpg`;
        return res.status(200).json({ code: 200, msg: "ok", data: { avatarUrl } });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("users/avatar:", e);
        return res.status(200).json({ code: 200, msg: "ok", data: { avatarUrl: "" } });
    }
});

module.exports = { usersRouter };
