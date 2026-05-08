/**
 * 入库时按文本块调用 vLLM，抽取实体与四类关系（JSON）。
 * 开关：INGEST_KG_EXTRACT=1；需配置 VLLM_BASE_URL（与问答共用）。
 * 单块正文上限：INGEST_KG_EXTRACT_MAX_CHARS（默认 8000）。
 */

const { chatCompletionPlain } = require("./vllmClient");
const { clipText } = require("./kgChunkPayload");

const isKgExtractEnabled = () => {
    const v = String(process.env.INGEST_KG_EXTRACT || "")
        .toLowerCase()
        .trim();
    return v === "1" || v === "true" || v === "yes";
};

const parseJsonObject = (raw) => {
    let s = String(raw || "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("模型输出中未找到 JSON 对象");
    s = s.slice(start, end + 1);
    return JSON.parse(s);
};

const maxExtractChars = () => {
    const n = Number(process.env.INGEST_KG_EXTRACT_MAX_CHARS);
    if (Number.isFinite(n) && n >= 500) return Math.min(48_000, Math.floor(n));
    return 8000;
};

const maxLlmTokens = () => {
    const n = Number(process.env.INGEST_KG_EXTRACT_MAX_TOKENS);
    if (Number.isFinite(n) && n >= 256) return Math.min(8192, Math.floor(n));
    return 2048;
};

/**
 * @param {object} p
 * @param {string} p.chunkText
 * @param {number} p.chunkIndex
 * @param {object} [p.graphDocMeta]
 * @returns {Promise<{ entities: object[], edges: object[] }>}
 */
const extractKgFromChunkLlm = async ({ chunkText, chunkIndex, graphDocMeta = {} }) => {
    const baseUrl = process.env.VLLM_BASE_URL || "";
    if (!baseUrl) {
        throw new Error("Missing VLLM_BASE_URL");
    }

    const text = clipText(String(chunkText || ""), maxExtractChars());
    const title = String(graphDocMeta.title || "").trim().slice(0, 240);
    const kt = String(graphDocMeta.knowledgeType || "").trim();
    const section = String(graphDocMeta.sectionHeading || "").trim().slice(0, 300);

    const chunkLabel = `文档块#${chunkIndex}`;

    const system = [
        "你是企业知识库的知识图谱抽取模块，只输出合法 JSON，不要输出任何解释或 Markdown 代码围栏外的文字。",
        "实体类型 entityTypeCode 只能是：DocumentChunk（向量分块）、FAQ、Policy（制度条款/要点）、Department（部门/组织）。",
        "关系 relationTypeCode 只能是：references（引用）、belongs_to（属于）、applies_to（适用于）、supersedes（替代）。",
        "约束：references 的「头实体」必须是 DocumentChunk；applies_to 的「尾实体」应是 Department；supersedes 的头尾应均为 Policy。",
        "无法从正文确定时不要编造：宁可少抽。",
        "JSON 顶层结构：",
        '{"entities":[{"entityTypeCode":"DocumentChunk","name":"' +
            chunkLabel +
            '","properties":{"section":"可选小节标题"}}...],',
        '"edges":[{"relationTypeCode":"references","fromTypeCode":"DocumentChunk","fromName":"' +
            chunkLabel +
            '","toTypeCode":"FAQ","toName":"某问题","confidence":0.85}...]}',
        "fromName/toName 必须与 entities 中对应项的 name 完全一致（含空格）。confidence 可选 0~1。"
    ].join("");

    const user = [
        `文档标题：${title || "（无）"}`,
        `知识类型：${kt || "（无）"}`,
        `当前分块序号（从 0 开始）：${chunkIndex}`,
        section ? `小节标题：${section}` : "",
        "",
        "【必须】entities 中必须包含且仅使用本块对应的 DocumentChunk：",
        `{"entityTypeCode":"DocumentChunk","name":"${chunkLabel}"}`,
        "可在其 properties 中写入 section 等简短信息。",
        "",
        "【分块正文】",
        text
    ]
        .filter(Boolean)
        .join("\n");

    const raw = await chatCompletionPlain({
        system,
        user,
        temperature: 0.12,
        maxTokens: maxLlmTokens()
    });

    const parsed = parseJsonObject(raw);
    const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
    const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
    return { entities, edges, rawLen: raw.length };
};

module.exports = {
    isKgExtractEnabled,
    extractKgFromChunkLlm,
    parseJsonObject
};
