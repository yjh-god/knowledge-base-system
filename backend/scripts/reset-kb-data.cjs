/**
 * 一键清空知识库内容（测乱后统一重来）：
 * - SQL：documents、index_jobs、kg 实例、同步运行历史、同步状态摘要、相关 audit
 * - 磁盘：storage/uploads、storage/mirror（可用 RESET_KB_KEEP_MIRROR=1 保留 mirror）
 * - Qdrant：删除向量集合（下次入库自动建）
 * 不删：用户/部门/API Key、图谱类型字典、kb_sync_settings 配置项本身。
 * 用法：在 backend 目录  npm run reset-kb
 */
const fs = require("fs");
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

const sqlFile = path.join(__dirname, "..", "sql", "006_reset_kb_documents_and_jobs.sql");
if (!fs.existsSync(sqlFile)) {
    // eslint-disable-next-line no-console
    console.error("找不到", sqlFile);
    process.exit(1);
}

// eslint-disable-next-line no-console
console.log("执行 SQL:", sqlFile);
execFileSync(
    "sqlcmd",
    ["-S", server, "-U", user, "-P", password, "-d", db, "-b", "-f", "65001", "-i", sqlFile],
    { stdio: "inherit", windowsHide: true }
);

const root = process.env.KB_STORAGE_ROOT
    ? path.resolve(String(process.env.KB_STORAGE_ROOT).trim())
    : path.join(__dirname, "..", "..", "storage");

const wipeDirRecreate = (dir, label) => {
    if (!fs.existsSync(dir)) {
        // eslint-disable-next-line no-console
        console.log(`${label} 目录不存在，跳过:`, dir);
        return;
    }
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        // eslint-disable-next-line no-console
        console.log(`${label} 已清空并重建:`, dir);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`${label} 清理失败:`, dir, (e && e.message) || e);
    }
};

wipeDirRecreate(path.join(root, "uploads"), "uploads");
if (String(process.env.RESET_KB_KEEP_MIRROR || "").trim() !== "1") {
    wipeDirRecreate(path.join(root, "mirror"), "mirror");
} else {
    // eslint-disable-next-line no-console
    console.log("已按 RESET_KB_KEEP_MIRROR=1 保留 mirror 目录");
}

const qdrantUrl = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/+$/, "");
const collection = process.env.QDRANT_COLLECTION || "kb_chunks";
const delUrl = `${qdrantUrl}/collections/${encodeURIComponent(collection)}`;

async function qdrantDrop() {
    try {
        const res = await fetch(delUrl, { method: "DELETE" });
        if (res.ok || res.status === 200) {
            // eslint-disable-next-line no-console
            console.log("Qdrant 集合已删除:", collection);
        } else if (res.status === 404) {
            // eslint-disable-next-line no-console
            console.log("Qdrant 集合不存在，跳过:", collection);
        } else {
            const t = await res.text().catch(() => "");
            // eslint-disable-next-line no-console
            console.warn("Qdrant 删除集合返回", res.status, t.slice(0, 200));
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("Qdrant 请求失败（可稍后手动删集合）:", (e && e.message) || e);
    }
}

qdrantDrop()
    .then(() => {
        // eslint-disable-next-line no-console
        console.log("reset-kb-data 完成。");
    })
    .catch((e) => {
        // eslint-disable-next-line no-console
        console.error(e);
        process.exit(1);
    });
