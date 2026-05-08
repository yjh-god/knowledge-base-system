const withTimeout = async (promise, timeoutSeconds, abortController) => {
    const timeoutMs = Math.max(1, Number(timeoutSeconds) * 1000);
    const timeout = new Promise((_, reject) => {
        setTimeout(() => {
            abortController.abort();
            reject(new Error("vLLM request timeout"));
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]);
};

const normalizeBaseUrl = (baseUrl) => {
    if (!baseUrl) return baseUrl;
    return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
};

const buildCitation = (payload) => {
    const filePath = payload?.file_path || "";
    const fileName = payload?.file_name || "";
    const charStart = payload?.char_start;
    const charEnd = payload?.char_end;
    const sheetName = payload?.sheet_name;
    const rowStart = payload?.row_start;
    const rowEnd = payload?.row_end;

    const locParts = [];
    if (filePath) locParts.push(filePath);
    if (fileName && fileName !== filePath) locParts.push(`(${fileName})`);

    if (sheetName != null) {
        locParts.push(`sheet=${sheetName}`);
    }
    if (rowStart != null && rowEnd != null) {
        locParts.push(`rows=${rowStart}-${rowEnd}`);
    }
    if (charStart != null && charEnd != null) {
        locParts.push(`chars=${charStart}-${charEnd}`);
    }

    return locParts.join(" ");
};

/**
 * 从 OpenAI / vLLM 兼容的 chat.completions 响应中取出助手正文。
 * 兼容：字符串 content、content 数组、思考类模型的 reasoning_content、纯 text 字段。
 */
const extractAssistantText = (json) => {
    const choice = json?.choices?.[0];
    if (!choice) return "";

    const msg = choice.message || choice.delta || {};

    const c = msg.content;
    if (typeof c === "string" && c.trim()) return c.trim();
    if (Array.isArray(c)) {
        const t = c
            .map((block) => {
                if (typeof block === "string") return block;
                if (block && typeof block.text === "string") return block.text;
                return "";
            })
            .join("");
        if (t.trim()) return t.trim();
    }

    const r = msg.reasoning_content || msg.reasoning;
    if (typeof r === "string" && r.trim()) return r.trim();

    if (typeof choice.text === "string" && choice.text.trim()) return choice.text.trim();

    return "";
};

/**
 * 思考类模型常把链式推理写进 content，或带 think 标签；RAG 应对用户只展示最终答复。
 */
const stripThinkingFromAnswer = (raw) => {
    if (!raw || typeof raw !== "string") return "";
    let s = raw.replace(/\r\n/g, "\n").trim();
    s = s
        .replace(new RegExp("<" + "think" + ">[\\s\\S]*?<\\/" + "think" + ">", "gi"), "")
        .trim();
    s = s
        .replace(
            new RegExp(
                "<" + "redacted_thinking" + ">[\\s\\S]*?<\\/" + "redacted_thinking" + ">",
                "gi"
            ),
            ""
        )
        .trim();
    s = s
        .replace(
            new RegExp(
                "<" + "redacted_reasoning" + ">[\\s\\S]*?<\\/" + "redacted_reasoning" + ">",
                "gi"
            ),
            ""
        )
        .trim();

    const thinkingHead =
        /^Thinking Process:/im.test(s) ||
        /^Reasoning:/im.test(s) ||
        /^思考过程[:：]/m.test(s);
    if (thinkingHead) {
        const h2 = s.search(/\n##\s+/);
        if (h2 > 0) {
            s = s.slice(h2 + 1).trim();
        } else {
            const lines = s.split("\n");
            let startIdx = -1;
            for (let i = 0; i < lines.length; i++) {
                const cjk = (lines[i].match(/[\u4e00-\u9fff]/g) || []).length;
                if (cjk >= 6) {
                    startIdx = i;
                    break;
                }
            }
            if (startIdx > 0) s = lines.slice(startIdx).join("\n").trim();
        }
    }

    return s.trim();
};

const sanitizeConversationContext = (raw) => {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw.slice(-12)) {
        if (!item || typeof item !== "object") continue;
        const role =
            item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
        if (!role) continue;
        const content = String(item.content || "")
            .trim()
            .slice(0, 4000);
        if (!content) continue;
        out.push({ role, content });
    }
    return out;
};

const buildConversationPrefix = (turns) => {
    if (!turns.length) return "";
    const lines = turns.map((t) => {
        const label = t.role === "user" ? "用户" : "助手";
        return `${label}：${t.content}`;
    });
    return `---- 此前对话（仅用于理解指代与衔接；制度事实必须以本轮「参考资料」为准）----\n${lines.join("\n")}\n---- 当前轮 ----\n\n`;
};

const synthesizeWithVllm = async ({ query, hits, conversationContext }) => {
    const baseUrl = process.env.VLLM_BASE_URL || "";
    if (!baseUrl) {
        throw new Error("Missing VLLM_BASE_URL");
    }

    const model = process.env.VLLM_MODEL || "qwen";
    const apiKey = process.env.VLLM_API_KEY || "";
    const timeoutSeconds = process.env.VLLM_TIMEOUT_SECONDS
        ? Number(process.env.VLLM_TIMEOUT_SECONDS)
        : 90;
    const maxTokens = process.env.VLLM_MAX_TOKENS ? Number(process.env.VLLM_MAX_TOKENS) : 2048;

    const refMax = process.env.VLLM_REF_MAX_CHARS
        ? Math.max(2000, Math.min(50000, Number(process.env.VLLM_REF_MAX_CHARS)))
        : 12000;

    const candidates = (hits || []).slice(0, 10);
    const refs = candidates.map((h, idx) => {
        const payload = h || {};
        const cite = buildCitation(payload);
        let preview = payload.text_preview || "";
        if (preview.length > refMax) {
            const head = Math.floor(refMax * 0.52);
            const tail = refMax - head - 5;
            preview = `${preview.slice(0, head)}\n…\n${preview.slice(-tail)}`;
        }
        const src = payload.retrievalSource ? ` [来源:${payload.retrievalSource}]` : "";
        return `【参考${idx + 1}】${cite}${src}\n${preview}`;
    });

    const contextTurns = sanitizeConversationContext(conversationContext);
    const contextPrefix = buildConversationPrefix(contextTurns);

    const system = [
        "你是企业知识库问答助手，回答要清晰、专业，语气类似主流中文大模型助手（结构清楚、可直接阅读）。",
        "若用户问题指代上文（如「那上面说的」「请假呢」），可结合「此前对话」理解意图，但制度条文与数据只能来自本轮「参考资料」，不得凭记忆编造。",
        "只使用简体中文作答；禁止输出英文推理、禁止输出「Thinking Process」「Reasoning」「思考过程」等分析段落；不要复述本题约束条款。",
        "必须严格基于「参考资料」作答；不要使用参考资料以外的确定事实。",
        "使用 Markdown：先简短结论，再用 `## 说明` 分点展开，必要时用列表。",
        "关键句末尾用括号标注引用，例如（见【参考2】）。",
        "若资料不足以回答，明确说明「知识库中未找到相关规定」，并列出资料中相关的只言片语供用户判断。",
        "若某条参考资料的原文已直接涉及用户问题主题（例如用户问出差/离职而片段中出现「出差」「RS03」「离职」「辞职」「离职申请单」等），必须基于该原文作答，不得仅因片段前半是考勤/请假而声称「未找到相关规定」。"
    ].join("");

    const refBlock =
        refs.length > 0
            ? refs.join("\n\n---\n\n")
            : "（当前未检索到任何文档片段；请直接告知用户知识库暂无匹配内容，并给出如何补充关键词或联系管理员的建议。）";

    const user = `${contextPrefix}用户问题：${query}\n\n---- 参考资料 ----\n${refBlock}\n\n---- 输出要求 ----\n1) 先给 1～3 句直接结论。\n2) 用 Markdown 组织正文，条理清楚。\n3) 重要事实必须带【参考n】引用（有资料时）。\n4) 资料冲突时说明并列出各自出处。\n5) 不要编造条款编号或日期。`;

    const abortController = new AbortController();
    const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const thinkingOn =
        String(process.env.VLLM_THINKING || "")
            .toLowerCase()
            .trim() === "true" ||
        String(process.env.VLLM_THINKING || "").trim() === "1";

    const body = {
        model,
        messages: [
            { role: "system", content: system },
            { role: "user", content: user }
        ],
        temperature: 0.25,
        max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 2048
    };

    if (!thinkingOn) {
        body.chat_template_kwargs = { enable_thinking: false };
    }

    const res = await withTimeout(
        fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: abortController.signal }),
        timeoutSeconds,
        abortController
    );

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`vLLM error: ${res.status} ${text}`.slice(0, 800));
    }

    const json = await res.json();
    let answer = stripThinkingFromAnswer(extractAssistantText(json));

    if (!answer && candidates.length === 0) {
        answer =
            "未在知识库中检索到与本次问题相关的文档片段。建议：① 换用制度里可能出现的专有名词再试；② 确认相关文档已上传且您所在部门在可见范围内；③ 联系管理员补充或调整文档可见部门。";
    } else if (!answer) {
        answer =
            "大模型未返回有效正文，但下方仍列出检索到的参考片段，请直接阅读引用中的原文；若仍无法解决，可联系管理员检查模型服务或更换非「思考」类模型。";
    }

    const citations = candidates.map((h) => buildCitation(h || {}));

    return { answer, citations };
};

/**
 * 通用 chat 调用（对比说明等）；未配置 VLLM_BASE_URL 时由调用方处理。
 */
const chatCompletionPlain = async ({ system, user, temperature = 0.2, maxTokens } = {}) => {
    const baseUrl = process.env.VLLM_BASE_URL || "";
    if (!baseUrl) {
        throw new Error("Missing VLLM_BASE_URL");
    }
    const model = process.env.VLLM_MODEL || "qwen";
    const apiKey = process.env.VLLM_API_KEY || "";
    const timeoutSeconds = process.env.VLLM_TIMEOUT_SECONDS
        ? Number(process.env.VLLM_TIMEOUT_SECONDS)
        : 90;
    const mt = maxTokens ?? (process.env.VLLM_MAX_TOKENS ? Number(process.env.VLLM_MAX_TOKENS) : 2048);

    const abortController = new AbortController();
    const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const thinkingOn =
        String(process.env.VLLM_THINKING || "")
            .toLowerCase()
            .trim() === "true" ||
        String(process.env.VLLM_THINKING || "").trim() === "1";

    const body = {
        model,
        messages: [
            { role: "system", content: String(system || "").slice(0, 12000) },
            { role: "user", content: String(user || "").slice(0, 48000) }
        ],
        temperature,
        max_tokens: Number.isFinite(mt) && mt > 0 ? mt : 2048
    };
    if (!thinkingOn) {
        body.chat_template_kwargs = { enable_thinking: false };
    }

    const res = await withTimeout(
        fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: abortController.signal }),
        timeoutSeconds,
        abortController
    );
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`vLLM error: ${res.status} ${text}`.slice(0, 800));
    }
    const json = await res.json();
    return stripThinkingFromAnswer(extractAssistantText(json));
};

module.exports = {
    synthesizeWithVllm,
    chatCompletionPlain,
    extractAssistantText,
    stripThinkingFromAnswer,
    sanitizeConversationContext
};
