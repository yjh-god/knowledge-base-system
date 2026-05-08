/**
 * 对比报告：Excel（三表）与 Word（摘要 + 并排摘录表）。
 */

const XLSX = require("xlsx");
const docx = require("docx");

const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType } =
    docx;

const DOCX_ROW_CAP = 200;

const sheetRowsFromDetails = (detailRows, colTitles) => {
    const t = colTitles || {};
    const uploadLine = t.lineLeft || "上传/左侧行号";
    const kbLine = t.lineRight || "知识库/右侧行号";
    const uploadCol = t.cellLeft || "上传/左侧摘录";
    const kbCol = t.cellRight || "知识库/右侧摘录";

    return detailRows.map((r) => ({
        序号: r.seq,
        左侧页: r.pageLeft,
        右侧页: r.pageRight,
        差异类型: r.changeType,
        [uploadLine]: r.uploadLineNo,
        [kbLine]: r.kbLineNo,
        [uploadCol]: r.uploadText,
        [kbCol]: r.kbText
    }));
};

const buildPageIndexRows = (detailRows) => {
    const m = new Map();
    for (const r of detailRows) {
        const pl = String(r.pageLeft ?? "").trim() || "—";
        const pr = String(r.pageRight ?? "").trim() || "—";
        const k = `${pl}|||${pr}`;
        m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()]
        .map(([k, cnt]) => {
            const [pl, pr] = k.split("|||");
            return { 左侧页: pl, 右侧页: pr, 差异行数: cnt };
        })
        .sort((a, b) => String(a.左侧页).localeCompare(String(b.左侧页), "zh-CN"));
};

/**
 * @returns {Buffer}
 */
const buildCompareExcelBuffer = (meta, stats, llmBlock, detailRows) => {
    const wb = XLSX.utils.book_new();
    const colTitles = meta.detailColTitles;
    const sheet1 = XLSX.utils.json_to_sheet(sheetRowsFromDetails(detailRows, colTitles));
    XLSX.utils.book_append_sheet(wb, sheet1, "差异明细");

    const sheet2 = XLSX.utils.json_to_sheet(buildPageIndexRows(detailRows));
    XLSX.utils.book_append_sheet(wb, sheet2, "变更页码索引");

    const summaryLines = [
        `生成时间：${meta.generatedAt || ""}`,
        `报告类型：${meta.reportVariant || ""}`,
        `匹配标题：${meta.matchedTitle || "—"}`,
        `上传文件名：${meta.uploadFileName || "—"}`,
        `知识库文档 ID：${meta.kbDocId || "—"}`,
        `左文件：${meta.leftFileName || "—"}`,
        `右文件：${meta.rightFileName || "—"}`,
        `左侧页码范围：${stats.pagesLeftStr || "—"}`,
        `右侧页码范围：${stats.pagesRightStr || "—"}`,
        `截断：${stats.truncated ? "是" : "否"}`,
        "",
        "—— 大模型说明与提示 ——",
        "",
        String(llmBlock || "")
    ];
    const sheet3 = XLSX.utils.aoa_to_sheet(summaryLines.map((line) => [line]));
    XLSX.utils.book_append_sheet(wb, sheet3, "概要说明");

    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};

const cellPara = (text) =>
    new Paragraph({
        children: [new TextRun({ text: String(text ?? ""), size: 18 })],
        alignment: AlignmentType.LEFT
    });

/**
 * @returns {Promise<Buffer>}
 */
const buildCompareDocxBuffer = async (meta, stats, llmBlock, detailRows) => {
    const colTitles = meta.detailColTitles || {};
    const h1 = colTitles.lineLeft || "左侧行";
    const h2 = colTitles.lineRight || "右侧行";
    const h3 = colTitles.cellLeft || "左侧摘录";
    const h4 = colTitles.cellRight || "右侧摘录";

    const headerRow = new TableRow({
        children: ["序号", "左页", "右页", "类型", h1, h2, h3, h4].map(
            (h) =>
                new TableCell({
                    children: [cellPara(h)],
                    width: { size: 12, type: WidthType.PERCENTAGE }
                })
        )
    });

    const slice = detailRows.slice(0, DOCX_ROW_CAP);
    const bodyRows = slice.map(
        (r) =>
            new TableRow({
                children: [
                    String(r.seq),
                    String(r.pageLeft ?? ""),
                    String(r.pageRight ?? ""),
                    String(r.changeType ?? ""),
                    String(r.uploadLineNo ?? ""),
                    String(r.kbLineNo ?? ""),
                    String(r.uploadText ?? ""),
                    String(r.kbText ?? "")
                ].map(
                    (c) =>
                        new TableCell({
                            children: [cellPara(c)],
                            width: { size: 12, type: WidthType.PERCENTAGE }
                        })
                )
            })
    );

    const document = new Document({
        sections: [
            {
                properties: {},
                children: [
                    new Paragraph({
                        children: [new TextRun({ text: "知识库文档对比报告", bold: true, size: 28 })]
                    }),
                    new Paragraph({ children: [new TextRun({ text: `生成：${meta.generatedAt || ""}`, size: 20 })] }),
                    new Paragraph({
                        children: [
                            new TextRun({
                                text: `类型：${meta.reportVariant || ""}；截断：${stats.truncated ? "是" : "否"}`,
                                size: 20
                            })
                        ]
                    }),
                    new Paragraph({ children: [new TextRun({ text: "说明与摘要", bold: true, size: 22 })] }),
                    new Paragraph({ children: [new TextRun({ text: String(llmBlock || "（无）"), size: 20 })] }),
                    new Paragraph({
                        children: [
                            new TextRun({
                                text: `逐行摘录（最多 ${DOCX_ROW_CAP} 行）`,
                                bold: true,
                                size: 22
                            })
                        ]
                    }),
                    new Table({
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        rows: [headerRow, ...bodyRows]
                    })
                ]
            }
        ]
    });

    return Packer.toBuffer(document);
};

module.exports = {
    buildCompareExcelBuffer,
    buildCompareDocxBuffer
};
