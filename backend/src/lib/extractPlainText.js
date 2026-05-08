/**
 * 文档对比：抽取整篇纯文本，并为每一物理行附带页码/位置（PDF 按页；表格按行号等）。
 */

const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");

const tryRequire = (name) => {
    try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        return require(name);
    } catch {
        return null;
    }
};

const decodeTextBuffer = (buf) => {
    if (!Buffer.isBuffer(buf)) return String(buf ?? "");
    const utf8 = buf.toString("utf8");
    const replUtf = (utf8.match(/\uFFFD/g) || []).length;
    const nul = utf8.indexOf("\0");
    if (nul >= 0 && nul < Math.min(utf8.length, 4096)) {
        return utf8;
    }
    let gbkText = "";
    let replGbk = Infinity;
    try {
        gbkText = iconv.decode(buf, "gbk");
        replGbk = (gbkText.match(/\uFFFD/g) || []).length;
    } catch {
        /* ignore */
    }
    const han = (t) => (String(t).match(/[\u4e00-\u9fff]/g) || []).length;
    if (replUtf === 0) return utf8;
    if (replGbk < replUtf) return gbkText;
    if (replUtf > 0 && han(gbkText) > han(utf8) * 1.2) return gbkText;
    return utf8;
};

const pdfPagerender = (pageData) => {
    const renderOptions = {
        normalizeWhitespace: false,
        disableCombineTextItems: false
    };
    return pageData.getTextContent(renderOptions).then((textContent) => {
        let lastY;
        let text = "";
        for (const item of textContent.items) {
            if (lastY === item.transform[5] || !lastY) {
                text += item.str;
            } else {
                text += `\n${item.str}`;
            }
            lastY = item.transform[5];
        }
        return text;
    });
};

const extractDocxPlain = (filePath) => {
    const AdmZip = tryRequire("adm-zip");
    if (!AdmZip) return "";
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry("word/document.xml");
    if (!entry) return "";
    const xml = entry.getData().toString("utf8");
    const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
    const lines = [];
    let pm;
    while ((pm = pRe.exec(xml)) !== null) {
        const pxml = pm[0];
        const texts = [];
        const tRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
        let tm;
        while ((tm = tRe.exec(pxml)) !== null) texts.push(tm[1]);
        const line = texts
            .join("")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/\s+/g, " ")
            .trim();
        if (line) lines.push(line);
    }
    return lines.join("\n");
};

const extractPptxPlain = (filePath) => {
    const AdmZip = tryRequire("adm-zip");
    if (!AdmZip) return "";
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const slides = [];
    for (const ent of entries) {
        const n = ent.entryName.replace(/\\/g, "/");
        const m = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(n);
        if (m) slides.push({ index: parseInt(m[1], 10), name: n });
    }
    slides.sort((a, b) => a.index - b.index);
    const parts = [];
    for (const { index, name } of slides) {
        const ent = zip.getEntry(name);
        if (!ent) continue;
        const xml = ent.getData().toString("utf8");
        const texts = [];
        const tRe = /<a:t[^>]*>([^<]*)<\/a:t>/g;
        let tm;
        while ((tm = tRe.exec(xml)) !== null) texts.push(tm[1]);
        const text = texts.join(" ").replace(/\s+/g, " ").trim();
        if (text) parts.push(`[幻灯片 ${index}] ${text}`);
    }
    return parts.join("\n");
};

const extractHtmlPlain = (filePath) => {
    const raw = fs.readFileSync(filePath);
    return decodeTextBuffer(raw)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, "\n")
        .replace(/\s+/g, " ")
        .trim();
};

/**
 * @param {{ filePath: string, mimeType?: string }} opts
 * @returns {Promise<{ text: string, linePages: Array<number|string|null> }>}
 */
const extractComparePlainWithPages = async ({ filePath, mimeType }) => {
    const ext = path.extname(filePath).toLowerCase();
    const mt = String(mimeType || "").toLowerCase();

    if (ext === ".pdf") {
        const pdfParse = tryRequire("pdf-parse");
        if (!pdfParse) {
            return {
                text: "",
                linePages: []
            };
        }
        const buf = fs.readFileSync(filePath);
        const pageTexts = [];
        await pdfParse(buf, {
            pagerender: async (pageData) => {
                const t = await pdfPagerender(pageData);
                const normalized = String(t || "")
                    .replace(/\s+/g, " ")
                    .trim();
                pageTexts.push(normalized);
                return t;
            }
        });
        const lines = [];
        const linePages = [];
        for (let p = 0; p < pageTexts.length; p += 1) {
            const raw = String(pageTexts[p] || "");
            const plines = raw.split(/\r?\n/);
            for (const ln of plines) {
                lines.push(ln);
                linePages.push(p + 1);
            }
        }
        return { text: lines.join("\n"), linePages };
    }

    if (ext === ".xlsx" || ext === ".xls" || ext === ".xlsm") {
        const { parseFileToChunks } = require("../parser/loadChunks");
        const chunks = await parseFileToChunks({
            filePath,
            mimeType: mt || "application/octet-stream",
            chunking: { chunkSize: 10_000_000, chunkOverlap: 0 }
        });
        const lines = [];
        const linePages = [];
        for (const ch of chunks) {
            const t = String(ch.text || "");
            const ls = t.split(/\r?\n/);
            const rs = ch.row_start != null ? Number(ch.row_start) : 1;
            for (let i = 0; i < ls.length; i += 1) {
                lines.push(ls[i]);
                const sheet = ch.sheet_name != null ? String(ch.sheet_name) : "";
                linePages.push(sheet ? `${sheet}:${rs + i}` : rs + i);
            }
        }
        return { text: lines.join("\n"), linePages };
    }

    let plain = "";
    if (ext === ".docx") {
        plain = extractDocxPlain(filePath);
    } else if (ext === ".pptx") {
        plain = extractPptxPlain(filePath);
    } else if (ext === ".html" || ext === ".htm") {
        plain = extractHtmlPlain(filePath);
    } else if (
        ext === ".txt" ||
        ext === ".log" ||
        ext === ".csv" ||
        ext === ".md" ||
        ext === ".markdown" ||
        mt === "text/plain"
    ) {
        plain = decodeTextBuffer(fs.readFileSync(filePath));
    } else {
        const { parseFileToChunks } = require("../parser/loadChunks");
        const chunks = await parseFileToChunks({
            filePath,
            mimeType: mt || "application/octet-stream",
            chunking: { chunkSize: 10_000_000, chunkOverlap: 0 }
        });
        plain = chunks.map((c) => String(c.text || "")).join("\n\n");
    }

    const lines = String(plain || "").split(/\r?\n/);
    const linePages = lines.map(() => null);
    return { text: lines.join("\n"), linePages };
};

module.exports = {
    extractComparePlainWithPages
};
