const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");

const { chunkText, defaultChunking } = require("../lib/chunking");

/** UTF-8 优先；含替换符或明显乱码时尝试 GBK（PRD：编码探测） */
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
    } catch (_) {
        /* ignore */
    }
    const han = (t) => (String(t).match(/[\u4e00-\u9fff]/g) || []).length;
    if (replUtf === 0) return utf8;
    if (replGbk < replUtf) return gbkText;
    if (replUtf > 0 && han(gbkText) > han(utf8) * 1.2) return gbkText;
    return utf8;
};

const tryRequire = (name) => {
    try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        return require(name);
    } catch (_) {
        return null;
    }
};

/** 与 pdf-parse 内置 pagerender 一致（按页抽取文本） */
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

const parseTxt = ({ filePath, chunking }) => {
    const raw = fs.readFileSync(filePath);
    const text = decodeTextBuffer(raw);
    const chunks = chunkText(text, chunking);
    return chunks.map((c) => ({
        text: c.text,
        charStart: c.charStart,
        charEnd: c.charEnd
    }));
};

/**
 * Markdown：按标题路径分块，写入 section_heading（PRD §5.1）。
 */
const parseMarkdown = ({ filePath, chunking }) => {
    const raw = fs.readFileSync(filePath);
    const text = decodeTextBuffer(raw);
    const lines = text.split(/\n/);
    let pathStack = [];
    const blocks = [];
    let body = [];

    const flushBlock = () => {
        const t = body.join("\n").trim();
        if (t) {
            const section_heading =
                pathStack.length > 0 ? pathStack.filter(Boolean).join(" > ") : null;
            blocks.push({ section_heading, text: t });
        }
        body = [];
    };

    for (const line of lines) {
        const hm = line.match(/^(#{1,6})\s+(.+)/);
        if (hm) {
            flushBlock();
            const level = hm[1].length;
            const title = hm[2].trim();
            pathStack = pathStack.slice(0, level - 1);
            pathStack[level - 1] = title;
            pathStack.length = level;
        } else {
            body.push(line);
        }
    }
    flushBlock();

    if (blocks.length === 0) {
        return [{ text: text.trim() || "（空 Markdown）", section_heading: null }];
    }

    const out = [];
    for (const b of blocks) {
        const sub = chunkText(b.text, chunking);
        for (const c of sub) {
            out.push({
                text: c.text,
                charStart: c.charStart,
                charEnd: c.charEnd,
                section_heading: b.section_heading
            });
        }
    }
    return out;
};

const parseXlsxAllSheets = ({ filePath, rowsPerChunk }) => {
    let XLSX;
    try {
        // eslint-disable-next-line global-require
        XLSX = require("xlsx");
    } catch (e) {
        throw new Error(
            "缺少 xlsx 依赖：请在 backend 安装 xlsx（用于 Excel 多 Sheet 解析）。"
        );
    }

    const skipHidden =
        String(process.env.XLSX_SKIP_HIDDEN_SHEETS || "1").trim() === "1";

    const workbook = XLSX.readFile(filePath, { cellText: true });
    const sheetNames = workbook.SheetNames || [];

    const chunks = [];
    const fromEnv = process.env.XLSX_ROWS_PER_CHUNK;
    const perChunk = rowsPerChunk
        ? Math.max(1, Number(rowsPerChunk) || 5)
        : fromEnv
          ? Math.max(1, Math.min(500, Number(fromEnv) || 5))
          : 5;

    sheetNames.forEach((sheetName, sheetIndex) => {
        if (skipHidden) {
            const wb = workbook.Workbook;
            const sheets = wb && Array.isArray(wb.Sheets) ? wb.Sheets : [];
            const meta = sheets.find((s) => s && String(s.name) === String(sheetName));
            if (meta && Number(meta.Hidden) > 0) return;
        }

        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

        for (let start = 0; start < rows.length; start += perChunk) {
            const end = Math.min(start + perChunk, rows.length);
            const rowsSlice = rows.slice(start, end);
            const grid = rowsSlice
                .map((row) => row.map((v) => (v == null ? "" : String(v))).join("\t"))
                .join("\n");
            /* 写入向量与 text_preview：含工作表名，便于「斜坡测试」等以 Sheet 命名的项目被检索命中 */
            const text = `工作表: ${sheetName}\n${grid}`;

            chunks.push({
                text,
                sheet_name: sheetName,
                sheet_index: sheetIndex,
                row_start: start + 1,
                row_end: end
            });
        }
    });

    return chunks;
};

const headingLevelFromDocxStyle = (style) => {
    if (!style) return 0;
    const m = /^Heading\s*(\d)$/i.exec(style) || /^标题\s*(\d)$/i.exec(style);
    if (m) return parseInt(m[1], 10);
    if (/^Title$/i.test(style)) return 1;
    return 0;
};

/**
 * DOCX：段落级抽取；Heading 样式写入 section_heading（页码 OOXML 不可靠，page_* 留空）。
 */
const parseDocx = ({ filePath, chunking }) => {
    const AdmZip = tryRequire("adm-zip");
    if (!AdmZip) {
        return [
            {
                text: "无法解析 .docx：后端未安装 adm-zip。请在 backend 目录执行 npm install。"
            }
        ];
    }
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry("word/document.xml");
    if (!entry) {
        return [{ text: "DOCX 文件异常：缺少 word/document.xml。" }];
    }
    const xml = entry.getData().toString("utf8");
    const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
    const paras = [];
    let pm;
    while ((pm = pRe.exec(xml)) !== null) {
        const pxml = pm[0];
        const styleM = pxml.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
        const style = styleM ? styleM[1] : "";
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
        if (line) paras.push({ style, line });
    }

    let pathStack = [];
    const blocks = [];
    let buf = [];

    const flush = () => {
        const t = buf.join("\n").trim();
        if (t) {
            const section_heading =
                pathStack.length > 0 ? pathStack.filter(Boolean).join(" > ") : null;
            blocks.push({ section_heading, text: t });
        }
        buf = [];
    };

    for (const { style, line } of paras) {
        const hl = headingLevelFromDocxStyle(style);
        if (hl > 0) {
            flush();
            pathStack = pathStack.slice(0, hl - 1);
            pathStack[hl - 1] = line;
            pathStack.length = hl;
        } else {
            buf.push(line);
        }
    }
    flush();

    if (blocks.length === 0) {
        return [{ text: "DOCX 未解析出可见文本（可能主要为图片/扫描件），请导出为 TXT 或使用可复制文本的文档。" }];
    }

    const out = [];
    for (const b of blocks) {
        const sub = chunkText(b.text, chunking);
        for (const c of sub) {
            out.push({
                text: c.text,
                charStart: c.charStart,
                charEnd: c.charEnd,
                section_heading: b.section_heading
            });
        }
    }
    return out;
};

/**
 * PPTX：解压读取各 slide 上文本，slide_index 1-based。
 */
const parsePptx = ({ filePath, chunking }) => {
    const AdmZip = tryRequire("adm-zip");
    if (!AdmZip) {
        return [{ text: "无法解析 .pptx：后端未安装 adm-zip。" }];
    }
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const slides = [];
    for (const ent of entries) {
        const n = ent.entryName.replace(/\\/g, "/");
        const m = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(n);
        if (m) slides.push({ index: parseInt(m[1], 10), name: n });
    }
    slides.sort((a, b) => a.index - b.index);
    if (!slides.length) {
        return [{ text: "PPTX 中未找到 ppt/slides/slide*.xml，可能已加密或结构异常。" }];
    }

    const chunks = [];
    for (const { index: slideIndex, name } of slides) {
        const ent = zip.getEntry(name);
        if (!ent) continue;
        const xml = ent.getData().toString("utf8");
        const texts = [];
        const tRe = /<a:t[^>]*>([^<]*)<\/a:t>/g;
        let tm;
        while ((tm = tRe.exec(xml)) !== null) texts.push(tm[1]);
        const text = texts.join(" ").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const sub = chunkText(text, chunking);
        for (const c of sub) {
            chunks.push({
                text: c.text,
                charStart: c.charStart,
                charEnd: c.charEnd,
                slide_index: slideIndex
            });
        }
    }
    if (!chunks.length) {
        return [
            {
                text: "PPTX 未解析出可见文本（可能主要为图片）。请导出备注为文本或转 PDF。",
                slide_index: 1
            }
        ];
    }
    return chunks;
};

/** 简单 HTML：去标签为文本（不做完整 DOM） */
const parseHtmlFile = ({ filePath, chunking }) => {
    const raw = fs.readFileSync(filePath);
    const text = decodeTextBuffer(raw)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, "\n")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) {
        return [{ text: "HTML 未解析出可见文本。" }];
    }
    const chunks = chunkText(text, chunking);
    return chunks.map((c) => ({
        text: c.text,
        charStart: c.charStart,
        charEnd: c.charEnd
    }));
};

const parsePdf = async ({ filePath, chunking }) => {
    const pdfParse = tryRequire("pdf-parse");
    if (!pdfParse) {
        return [
            {
                text: "无法解析 PDF：后端未安装 pdf-parse。请在 backend 目录执行 npm install。"
            }
        ];
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

    const chunks = [];
    for (let i = 0; i < pageTexts.length; i += 1) {
        const pageNo = i + 1;
        const pageText = pageTexts[i];
        if (!pageText) continue;
        const sub = chunkText(pageText, chunking);
        for (const c of sub) {
            chunks.push({
                text: c.text,
                charStart: c.charStart,
                charEnd: c.charEnd,
                page_start: pageNo,
                page_end: pageNo
            });
        }
    }

    if (chunks.length === 0) {
        return [
            {
                text: "PDF 未解析出文本（常见原因为扫描件/图片版 PDF）。请使用可复制文字的 PDF、导出为 TXT，或粘贴制度正文为 .txt 再入库。"
            }
        ];
    }
    return chunks;
};

const unsupportedPlaceholder = (ext, mimeType) => [
    {
        text: `无法解析的文件类型（${ext || mimeType || "unknown"}）。已支持：TXT/MD、HTML、DOC/DOCX、XLS/XLSX/XLSM、PPT/PPTX、PDF、PNG（OCR）、RTF（officeparser）。旧版二进制 .ppt 若失败请另存为 PPTX 或 PDF。`
    }
];

const flatTextToChunks = (text, chunking) => {
    const t = String(text || "").trim();
    if (!t) return [];
    const c = chunking || defaultChunking;
    return chunkText(t, c).map((x) => ({
        text: x.text,
        charStart: x.charStart,
        charEnd: x.charEnd
    }));
};

/** 旧版 Word .doc（OLE），不依赖本机 antiword */
const parseDocBinary = async ({ filePath, chunking }) => {
    const WordExtractor = tryRequire("word-extractor");
    if (!WordExtractor) {
        return [
            {
                text: "无法解析 .doc：后端缺少依赖 word-extractor，请在 backend 目录执行 npm install。"
            }
        ];
    }
    try {
        const extractor = new WordExtractor();
        const doc = await extractor.extract(filePath);
        const body = String(doc.getBody() || "").trim();
        if (!body) return [];
        return flatTextToChunks(body, chunking);
    } catch (e) {
        return [
            {
                text: `解析 .doc 失败：${String((e && e.message) || e).slice(0, 800)}`
            }
        ];
    }
};

/** PNG：tesseract.js（首次运行会下载语言包，需可访问外网或配置镜像） */
const parsePngOcr = async ({ filePath, chunking }) => {
    const TesseractMod = tryRequire("tesseract.js");
    const createWorker = TesseractMod && TesseractMod.createWorker;
    if (typeof createWorker !== "function") {
        return [
            {
                text: "无法解析 PNG：后端缺少 tesseract.js，请在 backend 目录执行 npm install。"
            }
        ];
    }
    let worker;
    try {
        worker = await createWorker("chi_sim+eng");
        const {
            data: { text }
        } = await worker.recognize(filePath);
        const t = String(text || "")
            .replace(/\s+/g, " ")
            .trim();
        if (!t) {
            return [
                {
                    text: "图片 OCR 未识别到文字（印刷体、分辨率过低或纯图无字时常见；可尝试更清晰截图或导出可复制 PDF）。"
                }
            ];
        }
        return flatTextToChunks(t, chunking);
    } catch (e) {
        return [
            {
                text: `PNG OCR 失败：${String((e && e.message) || e).slice(0, 600)}`
            }
        ];
    } finally {
        if (worker) {
            try {
                await worker.terminate();
            } catch (_) {
                /* ignore */
            }
        }
    }
};

/** officeparser：RTF、部分场景；二进制 .ppt 若格式受支持则可解析，否则返回 undefined 由调用方处理 */
const tryParseOfficeToChunks = async (filePath, chunking) => {
    const mod = tryRequire("officeparser");
    if (!mod || typeof mod.parseOffice !== "function") return undefined;
    try {
        const ast = await mod.parseOffice(filePath);
        const text =
            ast && typeof ast.toText === "function" ? String(ast.toText() || "").trim() : "";
        if (!text) return [];
        return flatTextToChunks(text, chunking);
    } catch {
        return undefined;
    }
};

/**
 * @returns {Promise<Array<{text: string, ...}>>}
 */
const parseFileToChunks = async ({ filePath, mimeType, chunking }) => {
    const ext = path.extname(filePath).toLowerCase();
    const ck = chunking || defaultChunking;

    if (ext === ".xlsx" || ext === ".xls" || ext === ".xlsm") {
        return parseXlsxAllSheets({ filePath });
    }

    if (ext === ".png") {
        return parsePngOcr({ filePath, chunking: ck });
    }

    if (ext === ".txt" || ext === ".log" || ext === ".csv" || mimeType === "text/plain") {
        return parseTxt({ filePath, chunking: ck });
    }

    if (ext === ".md" || ext === ".markdown") {
        return parseMarkdown({ filePath, chunking: ck });
    }

    if (ext === ".html" || ext === ".htm") {
        return parseHtmlFile({ filePath, chunking: ck });
    }

    if (ext === ".doc") {
        return parseDocBinary({ filePath, chunking: ck });
    }

    if (ext === ".docx") {
        return parseDocx({ filePath, chunking: ck });
    }

    if (ext === ".pptx") {
        return parsePptx({ filePath, chunking: ck });
    }

    if (ext === ".ppt") {
        const o = await tryParseOfficeToChunks(filePath, ck);
        if (o !== undefined) return o;
        return [];
    }

    if (ext === ".pdf") {
        return parsePdf({ filePath, chunking: ck });
    }

    if (ext === ".rtf") {
        const o = await tryParseOfficeToChunks(filePath, ck);
        if (o !== undefined) return o;
        return unsupportedPlaceholder(ext, mimeType);
    }

    return unsupportedPlaceholder(ext, mimeType);
};

module.exports = { parseFileToChunks };
