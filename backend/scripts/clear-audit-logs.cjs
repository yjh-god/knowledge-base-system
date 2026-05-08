/**
 * 清空操作审计表 dbo.audit_logs（含检索、文档、管理员操作等全部记录）
 * 用法：在 backend 目录执行  npm run clear-audit-logs
 */
const path = require("path");
const { execFileSync } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const server = process.env.MSSQL_SERVER;
const user = process.env.MSSQL_USER;
const password = process.env.MSSQL_PASSWORD;
const db = process.env.MSSQL_DATABASE || "knowledge_base";

if (!server || !user || password == null) {
    // eslint-disable-next-line no-console
    console.error("缺少 MSSQL_SERVER / MSSQL_USER / MSSQL_PASSWORD（backend/.env）");
    process.exit(1);
}

// eslint-disable-next-line no-console
console.log("执行: DELETE FROM dbo.audit_logs");
execFileSync(
    "sqlcmd",
    [
        "-S",
        server,
        "-U",
        user,
        "-P",
        password,
        "-d",
        db,
        "-b",
        "-f",
        "65001",
        "-Q",
        "DELETE FROM dbo.audit_logs;"
    ],
    { stdio: "inherit", windowsHide: true }
);
// eslint-disable-next-line no-console
console.log("clear-audit-logs 完成。");
