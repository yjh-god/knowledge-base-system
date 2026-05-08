/**
 * Node fetch 失败时常为 TypeError: fetch failed，真实原因在 err.cause 或 AggregateError.errors。
 */
const walkErr = (e, out, depth) => {
    if (!e || depth > 10) return;
    if (typeof e === "string") {
        out.push(e);
        return;
    }
    if (e.message) out.push(String(e.message));
    if (e.code) out.push(`code=${e.code}`);
    if (e.errno != null && e.errno !== "") out.push(`errno=${e.errno}`);
    if (e.syscall) out.push(`syscall=${e.syscall}`);
    if (e.address) out.push(`addr=${e.address}`);
    if (e.port != null) out.push(`port=${e.port}`);
    if (e.name && e.name !== "Error" && e.name !== "TypeError") out.push(`name=${e.name}`);
    if (Array.isArray(e.errors)) {
        for (const sub of e.errors) walkErr(sub, out, depth + 1);
    }
    walkErr(e.cause, out, depth + 1);
};

const formatFetchError = (url, err) => {
    const out = [`url=${url}`];
    walkErr(err, out, 0);
    const uniq = [];
    const seen = new Set();
    for (const x of out) {
        const k = x.slice(0, 120);
        if (!seen.has(k)) {
            seen.add(k);
            uniq.push(x);
        }
    }
    return uniq.join(" | ").slice(0, 950);
};

module.exports = { formatFetchError };
