import fs from "fs";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

// #region agent log
{
    const repoRoot = path.resolve(__dirname, "..");
    const line = `${JSON.stringify({
        sessionId: "840c9e",
        timestamp: Date.now(),
        runId: "vite-config-evaluated",
        hypothesisId: "SYS",
        location: "frontend/vite.config.js",
        message: "vite.config.js evaluated"
    })}\n`;
    for (const p of [path.join(repoRoot, "debug-840c9e.log"), path.join(repoRoot, ".cursor", "debug-840c9e.log")]) {
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.appendFileSync(p, line);
        } catch (_) {
            // ignore
        }
    }
}
// #endregion

/** 与后端默认 PORT 对齐，避免前端仍打 3001 而后端实际为 3002 时命中错误进程 */
function readBackendPortFromEnvFile() {
    try {
        const envPath = path.resolve(__dirname, "..", "backend", ".env");
        const text = fs.readFileSync(envPath, "utf8");
        const m = text.match(/^\s*PORT\s*=\s*(\d+)\s*$/m);
        if (m) return Number(m[1]);
    } catch (_) {
        /* no file */
    }
    return 3001;
}

/** Debug：确认本次 dev 是否由本仓库的 Vite 启动（写入知识库根目录 debug-840c9e.log） */
function debugSessionVitePlugin(repoRoot, apiProxyTarget) {
    return {
        name: "debug-session-vite",
        configureServer() {
            // #region agent log
            const line = `${JSON.stringify({
                sessionId: "840c9e",
                timestamp: Date.now(),
                runId: "vite-dev",
                hypothesisId: "SYS",
                location: "frontend/vite.config.js:configureServer",
                message: "Vite dev server starting",
                data: { repoRoot, apiProxyTarget, cwd: process.cwd() }
            })}\n`;
            let ok = false;
            let lastErr = null;
            for (const p of [path.join(repoRoot, "debug-840c9e.log"), path.join(repoRoot, ".cursor", "debug-840c9e.log")]) {
                try {
                    fs.mkdirSync(path.dirname(p), { recursive: true });
                    fs.appendFileSync(p, line);
                    ok = true;
                } catch (e) {
                    lastErr = e;
                }
            }
            if (!ok) {
                // eslint-disable-next-line no-console
                console.error("[debugSessionVitePlugin] failed to write debug log", {
                    errorCode: lastErr && lastErr.code,
                    message: lastErr && lastErr.message
                });
            }
            // #endregion
        }
    };
}

export default defineConfig(({ mode }) => {
    const repoRoot = path.resolve(__dirname, "..");
    const env = loadEnv(mode, repoRoot, "");
    const port = readBackendPortFromEnvFile();
    const apiProxyTarget =
        env.VITE_DEV_API_PROXY ||
        env.BACKEND_DEV_URL ||
        `http://127.0.0.1:${port}`;

    return {
        plugins: [vue(), debugSessionVitePlugin(repoRoot, apiProxyTarget)],
        esbuild: {
            charset: "utf8"
        },
        server: {
            port: 5173,
            // Windows 下仅用 `host:true` 有时仍只暴露在 IPv6；显式 0.0.0.0 保证 127.0.0.1:5173 可访问
            host: "0.0.0.0",
            strictPort: true,
            proxy: {
                "/api": {
                    target: apiProxyTarget,
                    changeOrigin: true
                }
            },
            fs: {
                // 允许加载项目根目录下的共享资源（frontend/src 中引用了 ../.. /assets）
                allow: [
                    path.resolve(__dirname),
                    path.resolve(__dirname, "..", "assets"),
                    repoRoot
                ]
            }
        }
    };
});

