/**
 * 调用 vLLM 生成对比说明（未配置服务时降级为空正文 + 提示）。
 */

const { chatCompletionPlain } = require("./vllmClient");

const sampleRows = (rows, max) => {
    const r = Array.isArray(rows) ? rows : [];
    const n = Math.max(0, Math.min(80, max));
    if (r.length <= n) return r;
    const head = Math.floor(n * 0.6);
    const tail = n - head;
    return [...r.slice(0, head), ...r.slice(-tail)];
};

/**
 * @param {object} opts
 * @returns {Promise<{ text: string, hint: string, degraded: boolean }>}
 */
const summarizeCompareForUser = async (opts) => {
    const baseUrl = String(process.env.VLLM_BASE_URL || "").trim();
    if (!baseUrl) {
        return {
            text: "",
            hint: "未配置 VLLM_BASE_URL，已跳过差异说明生成；仍可查看逐行明细与导出 Excel/Word。",
            degraded: true
        };
    }

    const kind = opts.compareKind === "two_files" ? "two_files" : "kb_same";
    const title = String(opts.matchedTitle || "文档对比");
    const stats = `左侧/上传删除或单侧行数（约）：${Number(opts.removedLines) || 0}；右侧/知识库新增或单侧行数（约）：${
        Number(opts.addedLines) || 0
    }；是否截断后对比：${opts.truncated ? "是" : "否"}。变更页码（左）：${String(
        opts.pagesLeftStr || "—"
    )}；（右）：${String(opts.pagesRightStr || "—")}。`;

    const samples = sampleRows(opts.diffDetailRows, 48);
    const table = samples
        .map((r) => {
            const a = [r.changeType, r.uploadLineNo, r.kbLineNo, r.pageLeft, r.pageRight]
                .map((x) => String(x ?? ""))
                .join("\t");
            return `${a}\n  左：${String(r.uploadText || "").slice(0, 200)}\n  右：${String(r.kbText || "").slice(0, 200)}`;
        })
        .join("\n---\n");

    const system = `你是企业知识库助手，根据结构化差异样本写「对比说明」。必须输出四段 Markdown 小标题：
一、总体结论（2～4 句）
二、主要差异类型与分布（条列）
三、核心变更（每条要点句末用括号标注页码，如（上传 p.3 / 知识库 p.5）；无法确定则写（页码不明））
四、建议核对方式（提醒用户用页码回到原文核对）

禁止编造文件中不存在的条款编号；若样本不足请明确说明。对比类型：${kind}。`;

    const user = `对比主题：${title}
${kind === "two_files" ? `左文件：${String(opts.leftFileName || "")}；右文件：${String(opts.rightFileName || "")}` : `上传文件名：${String(opts.uploadFileName || "")}`}

${stats}

以下为差异样本（摘录已截断，非全文）：
${table || "（无差异行）"}`;

    try {
        const text = await chatCompletionPlain({
            system,
            user,
            temperature: 0.2,
            maxTokens: process.env.VLLM_COMPARE_MAX_TOKENS
                ? Number(process.env.VLLM_COMPARE_MAX_TOKENS)
                : 3072
        });
        if (!String(text || "").trim()) {
            return {
                text: "",
                hint: "模型返回空内容，请检查 VLLM 服务或模型名称。",
                degraded: true
            };
        }
        return { text: String(text).trim(), hint: "", degraded: false };
    } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        return {
            text: "",
            hint: `差异说明生成失败：${msg.slice(0, 500)}`,
            degraded: true
        };
    }
};

module.exports = {
    summarizeCompareForUser
};
