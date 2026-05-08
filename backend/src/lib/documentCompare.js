/**
 * 行级文档差异：生成前端表格行、页码摘要与统计（供对比 API / 导出）。
 */

const { diffArrays } = require("diff");

const snippetMaxChars = () => {
    const n = Number(process.env.COMPARE_SNIPPET_MAX_CHARS);
    return Number.isFinite(n) && n >= 20 ? Math.min(4000, Math.floor(n)) : 240;
};

const maxTotalChars = () => {
    const n = Number(process.env.COMPARE_MAX_TOTAL_CHARS);
    return Number.isFinite(n) && n >= 10_000 ? Math.min(20_000_000, Math.floor(n)) : 2_000_000;
};

const clip = (s, max) => {
    const t = String(s ?? "");
    if (t.length <= max) return t;
    return `${t.slice(0, max)}…`;
};

const pageForLine = (linePages, lineNo1Based) => {
    if (!Array.isArray(linePages) || lineNo1Based < 1) return "";
    const p = linePages[lineNo1Based - 1];
    if (p == null || p === "") return "";
    return p;
};

const uniquePagesStr = (linePages) => {
    if (!Array.isArray(linePages)) return "";
    const s = new Set();
    for (const p of linePages) {
        if (p != null && p !== "") s.add(String(p));
    }
    return [...s]
        .sort((a, b) => {
            const na = Number(a);
            const nb = Number(b);
            if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === a && String(nb) === b) {
                return na - nb;
            }
            return String(a).localeCompare(String(b), "zh-CN");
        })
        .join(", ");
};

/**
 * @param {string} leftText
 * @param {string} rightText
 * @param {object} opts
 */
const buildDocumentDiffReport = (leftText, rightText, opts = {}) => {
    const leftLinePages = Array.isArray(opts.leftLinePages) ? opts.leftLinePages : [];
    const rightLinePages = Array.isArray(opts.rightLinePages) ? opts.rightLinePages : [];

    let truncated = false;
    const cap = maxTotalChars();
    let L = String(leftText ?? "");
    let R = String(rightText ?? "");
    if (L.length + R.length > cap) {
        truncated = true;
        const half = Math.floor(cap / 2);
        L = L.slice(0, half);
        R = R.slice(0, half);
    }

    const leftLines = L.split(/\r?\n/);
    const rightLines = R.split(/\r?\n/);

    const parts = diffArrays(leftLines, rightLines);
    const smax = snippetMaxChars();

    const diffLeftOnlyLine = opts.diffLeftOnlyLine || "仅左侧有";
    const diffRightOnlyLine = opts.diffRightOnlyLine || "仅右侧有";
    const diffChangedLine = opts.diffChangedLine || "对应行内容不同";

    let leftLineNo = 1;
    let rightLineNo = 1;
    let removedOnly = 0;
    let addedOnly = 0;
    let pairedChanges = 0;
    const detailRows = [];

    const pushRow = (row) => {
        detailRows.push({
            seq: detailRows.length + 1,
            pageLeft: row.pageLeft,
            pageRight: row.pageRight,
            changeType: row.changeType,
            uploadLineNo: row.uploadLineNo,
            kbLineNo: row.kbLineNo,
            uploadText: clip(row.uploadText, smax),
            kbText: clip(row.kbText, smax)
        });
    };

    for (let i = 0; i < parts.length; i += 1) {
        const cur = parts[i];
        if (!cur.added && !cur.removed) {
            leftLineNo += cur.value.length;
            rightLineNo += cur.value.length;
            continue;
        }

        if (cur.removed && i + 1 < parts.length && parts[i + 1].added) {
            const next = parts[i + 1];
            const nPair = Math.min(cur.value.length, next.value.length);
            for (let k = 0; k < nPair; k += 1) {
                const lnL = leftLineNo + k;
                const lnR = rightLineNo + k;
                pushRow({
                    pageLeft: pageForLine(leftLinePages, lnL),
                    pageRight: pageForLine(rightLinePages, lnR),
                    changeType: diffChangedLine,
                    uploadLineNo: lnL,
                    kbLineNo: lnR,
                    uploadText: cur.value[k],
                    kbText: next.value[k]
                });
                pairedChanges += 1;
            }
            if (cur.value.length > nPair) {
                for (let k = nPair; k < cur.value.length; k += 1) {
                    const lnL = leftLineNo + k;
                    pushRow({
                        pageLeft: pageForLine(leftLinePages, lnL),
                        pageRight: "",
                        changeType: diffLeftOnlyLine,
                        uploadLineNo: lnL,
                        kbLineNo: "",
                        uploadText: cur.value[k],
                        kbText: ""
                    });
                    removedOnly += 1;
                }
            }
            if (next.value.length > nPair) {
                for (let k = nPair; k < next.value.length; k += 1) {
                    const lnR = rightLineNo + k;
                    pushRow({
                        pageLeft: "",
                        pageRight: pageForLine(rightLinePages, lnR),
                        changeType: diffRightOnlyLine,
                        uploadLineNo: "",
                        kbLineNo: lnR,
                        uploadText: "",
                        kbText: next.value[k]
                    });
                    addedOnly += 1;
                }
            }
            leftLineNo += cur.value.length;
            rightLineNo += next.value.length;
            i += 1;
            continue;
        }

        if (cur.removed) {
            for (const line of cur.value) {
                pushRow({
                    pageLeft: pageForLine(leftLinePages, leftLineNo),
                    pageRight: "",
                    changeType: diffLeftOnlyLine,
                    uploadLineNo: leftLineNo,
                    kbLineNo: "",
                    uploadText: line,
                    kbText: ""
                });
                removedOnly += 1;
                leftLineNo += 1;
            }
            continue;
        }

        if (cur.added) {
            for (const line of cur.value) {
                pushRow({
                    pageLeft: "",
                    pageRight: pageForLine(rightLinePages, rightLineNo),
                    changeType: diffRightOnlyLine,
                    uploadLineNo: "",
                    kbLineNo: rightLineNo,
                    uploadText: "",
                    kbText: line
                });
                addedOnly += 1;
                rightLineNo += 1;
            }
        }
    }

    const title = opts.matchedTitle ? String(opts.matchedTitle) : "文档";
    const shortIntro = truncated
        ? `「${title}」对比正文过长，已按服务端上限截断后再算差异；导出与明细基于截断后的文本。`
        : `「${title}」共 ${leftLines.length} 行（左）与 ${rightLines.length} 行（右）；检出 ${detailRows.length} 条差异行（含修改与单侧行）。`;

    const pagesLeft = [...new Set(detailRows.map((r) => r.pageLeft).filter(Boolean))];
    const pagesRight = [...new Set(detailRows.map((r) => r.pageRight).filter(Boolean))];

    return {
        shortIntro,
        addedLines: addedOnly,
        removedLines: removedOnly,
        pairedChangeLines: pairedChanges,
        truncated,
        detailRows,
        pagesLeftStr: uniquePagesStr(leftLinePages),
        pagesRightStr: uniquePagesStr(rightLinePages),
        pagesLeft,
        pagesRight,
        snippetMaxChars: smax,
        localCharCount: L.length,
        kbCharCount: R.length
    };
};

module.exports = {
    buildDocumentDiffReport
};
