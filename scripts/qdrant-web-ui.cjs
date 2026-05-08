/**
 * 一键拉取并启动 Qdrant 官方 Web UI（独立页面，连接本机已在运行的 Qdrant API）。
 * 用法：npm run qdrant-ui
 * 环境变量：QDRANT_WEB_UI_PORT（默认 5174，避免与知识库前端 Vite 5173 冲突）
 *
 * Windows + Node 20+：spawn("npm.cmd", { shell: false }) 易触发 EINVAL；
 * 故用 node 直接执行 node_modules/vite/bin/vite.js。
 */
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const uiDir = path.join(root, "tools", "qdrant-web-ui");
const REPO = "https://github.com/qdrant/qdrant-web-ui.git";

const log = (m) => process.stderr.write(`${m}\n`);

const viteCliPath = () => path.join(uiDir, "node_modules", "vite", "bin", "vite.js");

const needsNpmInstall = () => !fs.existsSync(viteCliPath());

const ensureUi = () => {
    fs.mkdirSync(path.dirname(uiDir), { recursive: true });
    const pkg = path.join(uiDir, "package.json");
    if (!fs.existsSync(pkg)) {
        if (fs.existsSync(uiDir)) {
            fs.rmSync(uiDir, { recursive: true, force: true });
        }
        log(`[qdrant-ui] 正在克隆 ${REPO} …`);
        execSync(`git clone --depth 1 "${REPO}" "${uiDir}"`, {
            stdio: "inherit",
            cwd: path.dirname(uiDir),
            env: process.env
        });
    }
    if (needsNpmInstall()) {
        log("[qdrant-ui] 正在 npm install（首次较慢，依赖中含 GitHub 包需本机 Git）…");
        execSync("npm install", { stdio: "inherit", cwd: uiDir, env: process.env });
    }
    if (needsNpmInstall()) {
        throw new Error("npm install 后仍未找到 vite，请检查网络与 GitHub 访问");
    }
};

const main = () => {
    try {
        ensureUi();
    } catch (e) {
        log(`[qdrant-ui] 准备失败：${e?.message || e}`);
        log("请确认已安装 Git，且能访问 GitHub；或删除 tools/qdrant-web-ui/node_modules 后重试。");
        process.exit(1);
    }

    const port = String(process.env.QDRANT_WEB_UI_PORT || "5174").trim() || "5174";
    log(`[qdrant-ui] 启动开发服务器：http://127.0.0.1:${port}`);
    log("[qdrant-ui] 请保持本机 Qdrant 在运行（默认 http://127.0.0.1:6333）。按 Ctrl+C 结束。");

    const viteJs = viteCliPath();
    if (!fs.existsSync(viteJs)) {
        log("[qdrant-ui] 未找到 node_modules/vite/bin/vite.js");
        process.exit(1);
    }

    const child = spawn(process.execPath, [viteJs, "--host", "127.0.0.1", "--port", port], {
        cwd: uiDir,
        stdio: "inherit",
        env: process.env
    });
    child.on("exit", (code) => process.exit(code == null ? 1 : code));
};

main();
