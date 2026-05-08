const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const iconv = require("iconv-lite");

const hanCount = (s) => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;

/**
 * sqlcmd 在 Windows 上可能输出 UTF-8（-f 65001）或系统代码页（GBK）。
 * 可用 MSSQL_SQLCMD_STDOUT_ENCODING=utf8|gbk|auto 覆盖；未设置时在 win32 下按启发式在 utf8/gbk 间择优。
 */
const decodeSqlcmdStdout = (buf) => {
    if (!Buffer.isBuffer(buf)) return String(buf ?? "");
    const mode = (process.env.MSSQL_SQLCMD_STDOUT_ENCODING || "").toLowerCase().trim();
    if (mode === "gbk" || mode === "cp936") {
        return iconv.decode(buf, "gbk");
    }
    if (mode === "utf8" || mode === "utf-8") {
        return buf.toString("utf8");
    }
    const asUtf8 = buf.toString("utf8");
    if (mode === "auto") {
        const badU = (asUtf8.match(/\ufffd/g) || []).length;
        if (badU > 0) {
            const asGbk = iconv.decode(buf, "gbk");
            if ((asGbk.match(/\ufffd/g) || []).length < badU) return asGbk;
        }
        return asUtf8;
    }
    if (process.platform === "win32") {
        const badU = (asUtf8.match(/\ufffd/g) || []).length;
        if (badU > 0) {
            const asGbk = iconv.decode(buf, "gbk");
            if ((asGbk.match(/\ufffd/g) || []).length < badU) return asGbk;
        }
        const asGbk = iconv.decode(buf, "gbk");
        if (hanCount(asGbk) > hanCount(asUtf8)) return asGbk;
    }
    return asUtf8;
};

const execSqlcmd = async (args) => {
    return new Promise((resolve, reject) => {
        execFile(
            "sqlcmd",
            args,
            { windowsHide: true, encoding: "buffer", maxBuffer: 200 * 1024 * 1024 },
            (err, stdout, stderr) => {
                const outText = decodeSqlcmdStdout(stdout);
                const errText = decodeSqlcmdStdout(stderr);
                if (err) {
                    const text = `${errText}\n${outText}\n${err.message || ""}`.slice(0, 2500);
                    return reject(new Error(`sqlcmd failed: ${text}`));
                }
                return resolve({ stdout: outText });
            }
        );
    });
};

const getRequiredEnv = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
};

const runQueryWithConn = async (
    { server, user, password, database },
    query,
    { columnSeparator, variableLengthY } = {}
) => {
    const tmp = path.join(os.tmpdir(), `kb-sqlcmd-${crypto.randomBytes(8).toString("hex")}.sql`);
    fs.writeFileSync(tmp, `\uFEFF${query}`, "utf8");
    try {
        const args = [
            "-S",
            server,
            "-U",
            user,
            "-P",
            password,
            "-d",
            database,
            "-i",
            tmp,
            "-f",
            "65001",
            "-b",
            "-l",
            "10"
        ];

        if (columnSeparator != null && columnSeparator !== "") {
            args.push("-s", String(columnSeparator));
            // 与 -y 同时使用时部分 sqlcmd 版本报「-W 和 -y 互斥」，长列 TSV 只保留 -y
            if (variableLengthY === undefined || variableLengthY === null) {
                args.push("-W");
            }
        }
        if (variableLengthY !== undefined && variableLengthY !== null) {
            const y = Math.min(8000, Math.max(1, Number(variableLengthY) || 8000));
            args.push("-y", String(y));
        }
        // 无列名行便于 TSV 解析（与 -y 可同时使用；勿与 -W 同用）
        args.push("-h", "-1");

        const { stdout } = await execSqlcmd(args);
        return stdout;
    } finally {
        try {
            fs.unlinkSync(tmp);
        } catch (_) {
            /* ignore */
        }
    }
};

const runQuery = async (query, { database, columnSeparator, variableLengthY } = {}) => {
    const server = getRequiredEnv("MSSQL_SERVER");
    const user = getRequiredEnv("MSSQL_USER");
    const password = getRequiredEnv("MSSQL_PASSWORD");
    const db = database || process.env.MSSQL_DATABASE || "knowledge_base";
    return runQueryWithConn({ server, user, password, database: db }, query, {
        columnSeparator,
        variableLengthY
    });
};

/**
 * 连接 EHR 源库执行查询（与知识库 MSSQL_* 独立）。
 * 需配置：EHR_MSSQL_SERVER、EHR_MSSQL_DATABASE；账号密码默认 sa/空，可用 EHR_MSSQL_USER、EHR_MSSQL_PASSWORD。
 */
const runEhrQuery = async (query, opts = {}) => {
    const server = getRequiredEnv("EHR_MSSQL_SERVER");
    const user = process.env.EHR_MSSQL_USER || "sa";
    const password = process.env.EHR_MSSQL_PASSWORD ?? "";
    const database = getRequiredEnv("EHR_MSSQL_DATABASE");
    return runQueryWithConn({ server, user, password, database }, query, opts);
};

const runEhrQueryTsv = async (query, opts = {}) => {
    // 员工/部门名 TSV 不宜用 -y 8000（易超 48MB maxBuffer）；默认 512 足够
    const y = opts.variableLengthY != null ? opts.variableLengthY : 512;
    const stdout = await runEhrQuery(query, {
        ...opts,
        columnSeparator: "\t",
        variableLengthY: y
    });
    return parseTsvStdout(stdout);
};

/** 从 sqlcmd 输出中提取首段 JSON（配合 SELECT ... FOR JSON PATH） */
const parseSqlcmdJson = (stdout) => {
    const lines = String(stdout || "").split(/\r?\n/);
    const buf = [];
    let started = false;
    for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        // sqlcmd 可能先输出 “(1 row affected)” 再输出 JSON；原逻辑遇 affected 直接 break 会导致永远解析不到 JSON，
        // runQueryJson 抛错被吞后误判为「无批次」。
        const isRowCount =
            /^\(\d+/.test(t) &&
            (/(rows?\s+affected|row\s+affected)/i.test(t) || t.includes("\u884c\u53d7\u5f71\u54cd"));
        if (isRowCount) {
            if (started) break;
            continue;
        }
        if (t.startsWith("[") || t.startsWith("{")) {
            started = true;
        }
        if (started) {
            buf.push(t);
        }
    }
    const s = buf.join(" ").trim();
    if (!s) {
        throw new Error("sqlcmd: no JSON in output");
    }
    return JSON.parse(s);
};

/** 执行返回单列 JSON 的查询（FOR JSON PATH / WITHOUT_ARRAY_WRAPPER） */
const runQueryJson = async (query, opts) => {
    const stdout = await runQuery(query, opts);
    return parseSqlcmdJson(stdout);
};

/** 标量数字（如 COUNT） */
const runQueryScalarInt = async (query, opts) => {
    const stdout = await runQuery(query, opts);
    const m = String(stdout || "").match(/-?\d+/);
    return m ? Number(m[0]) : 0;
};

const isSqlcmdRowCountLine = (t) =>
    /^\(\d+/.test(t) &&
    (/(rows?\s+affected|row\s+affected)/i.test(t) || t.includes("\u884c\u53d7\u5f71\u54cd"));

/**
 * sqlcmd -s "\\t" -W -h -1 输出：多行，列间为 TAB（兼容 SQL Server 2014，无 FOR JSON）
 */
const parseTsvStdout = (stdout) => {
    const rows = [];
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const line = raw.replace(/\r$/, "");
        const t = line.trim();
        if (!t || isSqlcmdRowCountLine(t)) continue;
        rows.push(line.split("\t").map((c) => c.trim()));
    }
    return rows;
};

const runQueryTsv = async (query, opts = {}) => {
    const stdout = await runQuery(query, { ...opts, columnSeparator: "\t" });
    return parseTsvStdout(stdout);
};

module.exports = {
    runQuery,
    runQueryJson,
    runQueryScalarInt,
    runQueryTsv,
    parseTsvStdout,
    runEhrQuery,
    runEhrQueryTsv
};

// #region agent log
try {
    const { appendDebug } = require("./debugSessionLog");
    appendDebug({
        runId: "sqlcmd-module",
        hypothesisId: "SQLCMD_VER",
        location: "backend/src/lib/sqlcmd.js:loaded",
        message: "sqlcmd y clamp 1-8000 active",
        data: { pid: process.pid }
    });
} catch (_) {
    /* ignore */
}
// #endregion

