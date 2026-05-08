const errorMiddleware = (err, req, res, next) => {
    // eslint-disable-next-line no-console
    console.error("Unhandled error:", err && err.message ? err.message : err);

    const type = err && err.type;
    const isBadJson =
        type === "entity.parse.failed" ||
        (err instanceof SyntaxError && (err.status === 400 || String(err.message || "").includes("JSON")));
    if (isBadJson && !res.headersSent) {
        return res.status(400).json({
            code: 400,
            msg: "请求体不是合法 JSON（常见于 PowerShell 里 curl -d 引号写错）",
            data: {}
        });
    }

    if (!res.headersSent) {
        res.status(500).json({
            code: 500,
            msg: "服务器错误",
            data: {}
        });
    }
};

module.exports = { errorMiddleware };

