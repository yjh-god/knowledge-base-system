const fs = require("fs");
const { execFileSync, execSync, spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const ps1 = path.join(__dirname, "dev-with-kill.ps1");

// #region agent log
{
    const line = `${JSON.stringify({
        sessionId: "840c9e",
        timestamp: Date.now(),
        runId: "devjs-entry",
        hypothesisId: "SYS",
        location: "scripts/dev.js",
        message: "npm run dev invoked (node scripts/dev.js)",
        data: { root, cwd: process.cwd(), platform: process.platform }
    })}\n`;
    for (const p of [path.join(root, "debug-840c9e.log"), path.join(root, ".cursor", "debug-840c9e.log")]) {
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.appendFileSync(p, line);
        } catch (_) {
            /* ignore */
        }
    }
}
// #endregion

/** 避免 PATH 未含 powershell 时 npm run dev 直接失败 */
function resolvePowerShellExe() {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (fs.existsSync(candidate)) return candidate;
    return "powershell.exe";
}

function killPortUnix(port) {
    try {
        const out = execSync(`lsof -ti:${port}`, { encoding: "utf8", cwd: root }).trim();
        if (!out) return;
        const pids = out.split(/\s+/).filter(Boolean);
        for (const pid of pids) {
            try {
                process.kill(Number(pid), "SIGKILL");
            } catch (_) {
                /* ignore */
            }
        }
    } catch (_) {
        /* no listener / lsof missing */
    }
}

function startConcurrently() {
    const r = spawnSync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        [
            "concurrently",
            "-k",
            "-n",
            "backend,frontend,embedding",
            "-c",
            "blue,magenta,green",
            "npm run dev --prefix backend",
            "npm run dev --prefix frontend",
            "python embedding_server.py"
        ],
        { cwd: root, stdio: "inherit", shell: process.platform === "win32" }
    );
    process.exit(r.status === null ? 1 : r.status);
}

if (process.platform === "win32") {
    try {
        execFileSync(
            resolvePowerShellExe(),
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
            { cwd: root, stdio: "inherit" }
        );
    } catch (e) {
        process.exit(typeof e.status === "number" ? e.status : 1);
    }
} else {
    for (const port of [3001, 5173, 8902]) {
        killPortUnix(port);
    }
    startConcurrently();
}
