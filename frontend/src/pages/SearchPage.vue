<template>
    <div class="page page--search">
        <div class="chat-shell">
            <p v-if="metaLine && messages.length === 0" class="search-meta">{{ metaLine }}</p>

            <el-scrollbar class="scroll-area" ref="scrollRef">
                <div class="chat-flow">
                    <div v-if="messages.length === 0 && !sending" class="welcome">
                        <p class="welcome-title">试试这样问</p>
                        <p class="welcome-example">「打卡制度是什么」「年假如何申请」「报销需要哪些材料」</p>
                        <p class="welcome-hint">
                            品质 AI 助手基于知识库检索作答。开启「调试模式」可查看引用片段；「深度思考」展示检索与生成过程。
                            <strong>Enter</strong> 发送，<strong>Shift+Enter</strong> 换行。切换页面后<strong>对话与下方开关（混合、TopK 等）</strong>会保留，退出登录后清空。
                        </p>
                    </div>

                    <template v-for="msg in messages" :key="msg.id">
                        <div v-if="msg.role === 'user'" class="turn turn--user">
                            <div class="role role-user">你</div>
                            <div class="bubble user">{{ msg.text }}</div>
                        </div>

                        <div v-else class="turn turn--assistant">
                            <div class="role role-assistant">品质AI助手</div>

                            <div v-if="msg.pending" class="bubble assistant muted">
                                {{ msg.pendingCompare ? "正在解析并对比文件…" : "正在混合检索并生成回答…" }}
                            </div>

                            <template v-else>
                                <div
                                    v-if="msg.kind === 'file_compare'"
                                    class="bubble assistant compare-bubble"
                                >
                                    <p v-if="msg.shortIntro" class="compare-intro">{{ msg.shortIntro }}</p>
                                    <p v-if="msg.llmHint" class="compare-hint">{{ msg.llmHint }}</p>
                                    <div v-if="msg.llmExplanation" class="compare-section">
                                        <div class="compare-section-title">大模型差异说明</div>
                                        <div class="compare-plain">{{ msg.llmExplanation }}</div>
                                    </div>
                                    <div v-else-if="!msg.compareError" class="compare-muted">
                                        未生成大模型说明（可能未配置 VLLM）。可展开下方「逐行差异明细」或下载
                                        Excel（打开后第一个表即为「差异明细」）；Word 含摘要与并排表（条数有上限）。
                                    </div>
                                    <div v-if="msg.compareError" class="compare-plain compare-error">
                                        {{ msg.compareError }}
                                    </div>
                                    <el-collapse
                                        v-if="msg.diffRows && msg.diffRows.length"
                                        v-model="msg._compareOpen"
                                        class="compare-collapse"
                                    >
                                        <el-collapse-item
                                            title="逐行差异明细（页码+行号+短摘录；Excel 另有「变更页码索引」表）"
                                            name="rows"
                                        >
                                            <el-table
                                                :data="msg.diffRows"
                                                class="compare-table"
                                                stripe
                                                border
                                                size="small"
                                                max-height="440"
                                            >
                                                <el-table-column
                                                    prop="seq"
                                                    label="序号"
                                                    width="56"
                                                    align="center"
                                                />
                                                <el-table-column
                                                    prop="pageLeft"
                                                    :label="compareTbl(msg).pageUpload"
                                                    width="72"
                                                    align="center"
                                                />
                                                <el-table-column
                                                    prop="pageRight"
                                                    :label="compareTbl(msg).pageKb"
                                                    width="72"
                                                    align="center"
                                                />
                                                <el-table-column
                                                    prop="changeType"
                                                    label="差异类型"
                                                    min-width="140"
                                                    show-overflow-tooltip
                                                />
                                                <el-table-column
                                                    prop="uploadLineNo"
                                                    :label="compareTbl(msg).uploadLine"
                                                    width="88"
                                                    align="center"
                                                />
                                                <el-table-column
                                                    prop="kbLineNo"
                                                    :label="compareTbl(msg).kbLine"
                                                    width="100"
                                                    align="center"
                                                />
                                                <el-table-column
                                                    prop="uploadText"
                                                    :label="compareTbl(msg).uploadTextCol"
                                                    min-width="200"
                                                    show-overflow-tooltip
                                                />
                                                <el-table-column
                                                    prop="kbText"
                                                    :label="compareTbl(msg).kbTextCol"
                                                    min-width="200"
                                                    show-overflow-tooltip
                                                />
                                            </el-table>
                                            <p v-if="msg.diffRowsCapped" class="compare-cap">
                                                界面仅展示前 {{ msg.diffRows.length }} 条，共
                                                {{ msg.diffRowsTotal }} 条；Excel
                                                第一个表为「差异明细」，第二个为「变更页码索引」；正文为短摘录非全文。
                                            </p>
                                            <p v-else-if="msg.diffRows?.length" class="compare-cap">
                                                Excel：1「差异明细」2「变更页码索引」3「概要说明」；列为页码与短摘录（非全文）。
                                            </p>
                                        </el-collapse-item>
                                    </el-collapse>
                                    <div v-if="msg.reportExcelBase64" class="compare-dl-row">
                                        <el-button
                                            type="primary"
                                            size="small"
                                            @click="downloadCompareExcel(msg)"
                                        >
                                            下载 Excel 报告
                                        </el-button>
                                        <el-button
                                            type="success"
                                            size="small"
                                            :disabled="!msg.reportDocxBase64"
                                            @click="downloadCompareWord(msg)"
                                        >
                                            下载 Word 报告
                                        </el-button>
                                    </div>
                                    <p v-if="msg.reportExcelBase64" class="compare-muted compare-dl-hint">
                                        Excel：表1「差异明细」（页码+摘录）、表2「变更页码索引」、表3「概要说明」。Word：摘要
                                        + 并排摘录表。环境变量 COMPARE_SNIPPET_MAX_CHARS 可调摘录长度。
                                    </p>
                                    <p v-else-if="!msg.compareError" class="compare-muted">
                                        本次结果无导出文件（例如对比失败时）。
                                    </p>
                                    <p
                                        v-if="
                                            msg.kind === 'file_compare' &&
                                            !msg.compareError &&
                                            !msg.reportExcelBase64 &&
                                            (msg.shortIntro || (msg.diffRows && msg.diffRows.length))
                                        "
                                        class="compare-muted"
                                    >
                                        若本条为刷新页面后的历史记录，Excel/Word
                                        未保存在浏览器中，需重新执行一次对比方可下载完整报告。
                                    </p>
                                </div>
                                <template v-else>
                                <div
                                    v-if="form.deepThink && msg.pipelineSteps?.length"
                                    class="think-wrap"
                                >
                                    <el-collapse>
                                        <el-collapse-item name="think">
                                            <template #title>
                                                <span class="think-title">深度思考 · 处理过程</span>
                                            </template>
                                            <ol class="think-steps">
                                                <li v-for="(step, i) in msg.pipelineSteps" :key="i">
                                                    {{ step }}
                                                </li>
                                            </ol>
                                        </el-collapse-item>
                                    </el-collapse>
                                </div>

                                <div
                                    v-if="msg.ragDegradedHint"
                                    class="bubble assistant muted"
                                >
                                    {{ msg.ragDegradedHint }}
                                </div>

                                <div
                                    v-else-if="msg.text"
                                    class="bubble assistant answer-md"
                                    v-html="renderMd(msg.text)"
                                />

                                <div
                                    v-else-if="msg.searched && !msg.wantedAnswer"
                                    class="bubble assistant muted"
                                >
                                    当前为「仅检索」模式，未调用大模型。
                                    <span v-if="form.debugSources">下方「引用片段」中可查看得分与原文预览。</span>
                                </div>

                                <div
                                    v-else-if="msg.searched"
                                    class="bubble assistant muted"
                                >
                                    未收到有效 AI 正文。
                                    <span v-if="form.debugSources">请查看下方引用片段。</span>
                                </div>

                                <div
                                    v-if="form.debugSources && msg.hits?.length"
                                    class="sources-wrap"
                                >
                                    <el-collapse v-model="msg._srcOpen">
                                        <el-collapse-item name="sources">
                                            <template #title>
                                                <span class="collapse-title"
                                                    >引用片段 · {{ msg.hits.length }} 条</span
                                                >
                                            </template>
                                            <el-table
                                                :data="msg.hits"
                                                stripe
                                                border
                                                size="small"
                                                class="src-table"
                                            >
                                                <el-table-column
                                                    label="来源"
                                                    width="72"
                                                    align="center"
                                                >
                                                    <template #default="{ row }">
                                                        <el-tag
                                                            size="small"
                                                            :type="sourceTagType(row.retrievalSource)"
                                                        >
                                                            {{ sourceLabel(row.retrievalSource) }}
                                                        </el-tag>
                                                    </template>
                                                </el-table-column>
                                                <el-table-column
                                                    prop="score"
                                                    width="88"
                                                    align="center"
                                                >
                                                    <template #header>
                                                        <el-tooltip
                                                            placement="top"
                                                            content="混合检索下为 RRF 融合分（排名加权和，非百分比）；纯向量时为 Qdrant 相似度。"
                                                        >
                                                            <span class="th-tip">得分</span>
                                                        </el-tooltip>
                                                    </template>
                                                </el-table-column>
                                                <el-table-column
                                                    label="关键字分"
                                                    width="84"
                                                    align="center"
                                                >
                                                    <template #header>
                                                        <el-tooltip
                                                            placement="top"
                                                            content="基于查询分词在 text_preview / 文件名 / 路径上的命中强度（越大表示关键字越相关，非百分比）。"
                                                        >
                                                            <span class="th-tip">关键字分</span>
                                                        </el-tooltip>
                                                    </template>
                                                    <template #default="{ row }">
                                                        {{
                                                            row.keywordScore != null &&
                                                            Number.isFinite(Number(row.keywordScore))
                                                                ? Number(row.keywordScore).toFixed(1)
                                                                : "—"
                                                        }}
                                                    </template>
                                                </el-table-column>
                                                <el-table-column
                                                    label="向量分"
                                                    width="84"
                                                    align="center"
                                                >
                                                    <template #default="{ row }">
                                                        {{
                                                            row.vectorScore != null &&
                                                            Number.isFinite(Number(row.vectorScore))
                                                                ? Number(row.vectorScore).toFixed(3)
                                                                : "—"
                                                        }}
                                                    </template>
                                                </el-table-column>
                                                <el-table-column
                                                    prop="file_name"
                                                    label="文件"
                                                    width="140"
                                                    show-overflow-tooltip
                                                />
                                                <el-table-column
                                                    prop="file_path"
                                                    min-width="160"
                                                    show-overflow-tooltip
                                                >
                                                    <template #header>
                                                        <span title="双击单元格内路径可复制">路径</span>
                                                    </template>
                                                    <template #default="{ row }">
                                                        <span
                                                            class="hit-path-dbl"
                                                            :title="
                                                                row.file_path
                                                                    ? '双击复制：' + row.file_path
                                                                    : ''
                                                            "
                                                            @dblclick="copyHitPath(row)"
                                                            >{{ row.file_path || "—" }}</span
                                                        >
                                                    </template>
                                                </el-table-column>
                                                <el-table-column
                                                    prop="chunk_index"
                                                    label="块"
                                                    width="56"
                                                    align="center"
                                                />
                                                <el-table-column
                                                    label="定位"
                                                    min-width="148"
                                                    show-overflow-tooltip
                                                >
                                                    <template #default="{ row }">
                                                        {{ formatHitLocation(row) }}
                                                    </template>
                                                </el-table-column>
                                                <el-table-column
                                                    prop="text_preview"
                                                    label="预览"
                                                    min-width="220"
                                                    show-overflow-tooltip
                                                />
                                            </el-table>
                                            <p class="score-footnote">
                                                「得分」在<strong>混合</strong>模式下为 RRF 融合值（约
                                                <code>1/(60+排名)</code>
                                                量级相加），故常见
                                                <strong>0.02～0.08</strong>，不代表相关度百分比；排名字越靠前越好。「关键字分」为混合检索中对
                                                payload 文本/路径的命中加权（见表头说明）。「向量分」为 Qdrant
                                                余弦相似度（越高越近）。
                                            </p>
                                        </el-collapse-item>
                                    </el-collapse>
                                </div>
                                </template>
                            </template>
                        </div>
                    </template>
                </div>
            </el-scrollbar>

            <footer class="composer">
                <div class="composer-text-wrap">
                    <el-input
                        v-model="form.query"
                        type="textarea"
                        :rows="2"
                        resize="none"
                        placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                        class="q-input"
                        @keydown="onComposerKeydown"
                    />
                    <div v-if="compareFile" class="compare-chips">
                        <span class="chip-label">知识库同名对比</span>
                        <el-tag closable type="info" @close="clearKbFile">{{ compareFile.name }}</el-tag>
                    </div>
                    <div v-else-if="dualFileA && dualFileB" class="compare-chips">
                        <span class="chip-label">两文件互比</span>
                        <el-tag type="info">{{ dualFileA.name }}</el-tag>
                        <el-tag type="info">{{ dualFileB.name }}</el-tag>
                        <el-button text type="danger" size="small" @click="clearDualFiles">清除</el-button>
                    </div>
                </div>
                <input
                    ref="compareKbInputRef"
                    type="file"
                    class="hidden-compare-input"
                    accept=".txt,.md,.markdown,.pdf,.docx,.html,.htm,.xlsx,.xls,.csv,.pptx,.ppt,.log"
                    @change="onKbFilePicked"
                />
                <input
                    ref="compareDualInputRef"
                    type="file"
                    multiple
                    class="hidden-compare-input"
                    accept=".txt,.md,.markdown,.pdf,.docx,.html,.htm,.xlsx,.xls,.csv,.pptx,.ppt,.log"
                    @change="onDualFilesPicked"
                />
                <div class="composer-bar">
                    <div class="composer-bar-left">
                        <div class="switches">
                            <el-tooltip content="向量 + 关键字融合排序" placement="top">
                                <span class="sw-label">
                                    <el-switch
                                        v-model="form.hybrid"
                                        inline-prompt
                                        active-text="混合"
                                        inactive-text="仅向量"
                                    />
                                </span>
                            </el-tooltip>
                            <el-tooltip content="调用大模型生成自然语言答复" placement="top">
                                <span class="sw-label">
                                    <el-switch
                                        v-model="form.includeAnswer"
                                        inline-prompt
                                        active-text="AI答复"
                                        inactive-text="仅检索"
                                    />
                                </span>
                            </el-tooltip>
                            <el-tooltip content="展示检索与命中的处理步骤" placement="top">
                                <span class="sw-label">
                                    <el-switch
                                        v-model="form.deepThink"
                                        inline-prompt
                                        active-text="深度思考"
                                        inactive-text="简洁"
                                    />
                                </span>
                            </el-tooltip>
                            <el-tooltip content="关闭时不显示引用片段表格" placement="top">
                                <span class="sw-label">
                                    <el-switch
                                        v-model="form.debugSources"
                                        inline-prompt
                                        active-text="调试"
                                        inactive-text="调试关"
                                    />
                                </span>
                            </el-tooltip>
                            <span class="topk-wrap">
                                <span class="topk-label">TopK</span>
                                <el-input-number
                                    v-model="form.topK"
                                    :min="1"
                                    :max="50"
                                    size="small"
                                    controls-position="right"
                                />
                            </span>
                        </div>
                    </div>
                    <div class="composer-bar-actions">
                        <el-dropdown trigger="click" @command="onAttachCommand">
                            <el-button type="primary" class="attach-inline-btn">
                                <el-icon class="fab-ic"><Paperclip /></el-icon>
                                <span>对比附件</span>
                            </el-button>
                            <template #dropdown>
                                <el-dropdown-menu>
                                    <el-dropdown-item command="kb_one"
                                        >与知识库同名对比（选 1 个文件）</el-dropdown-item
                                    >
                                    <el-dropdown-item command="dual_two"
                                        >两个文件互相对比（一次选 2 个）</el-dropdown-item
                                    >
                                    <el-dropdown-item
                                        v-if="hasCompareFiles"
                                        divided
                                        command="clear_files"
                                        >清除已选文件</el-dropdown-item
                                    >
                                </el-dropdown-menu>
                            </template>
                        </el-dropdown>
                        <el-button type="primary" :loading="sending" class="send-btn" @click="onSearch"
                            >发送</el-button
                        >
                    </div>
                </div>
                <p class="composer-hint">
                    Enter 发送 · Shift+Enter 换行 · 引用编号与表格中「参考」一致 ·「对比附件」在发送左侧
                </p>
            </footer>
        </div>
    </div>
</template>

<script setup>
import { reactive, ref, watch, computed, nextTick, onMounted } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Paperclip } from "@element-plus/icons-vue";
import { api } from "../lib/api";
import { formatHitLocation, hitCopyPath } from "../lib/hitLocation";
import { ElMessage } from "element-plus";
import { useAuthStore, KB_CHAT_SESSION_KEY, KB_SEARCH_PREFS_KEY } from "../stores/auth";

marked.use({ breaks: true, gfm: true });

const authStore = useAuthStore();

const form = reactive({
    query: "",
    topK: 8,
    hybrid: true,
    includeAnswer: true,
    deepThink: false,
    debugSources: false
});

const sending = ref(false);
const compareFile = ref(null);
const dualFileA = ref(null);
const dualFileB = ref(null);
const compareKbInputRef = ref(null);
const compareDualInputRef = ref(null);

const defaultCompareTableLabels = () => ({
    uploadLine: "上传行号",
    kbLine: "知识库行号",
    uploadTextCol: "上传摘录",
    kbTextCol: "知识库摘录",
    pageUpload: "上传页",
    pageKb: "知识库页"
});

const compareTbl = (msg) => ({
    ...defaultCompareTableLabels(),
    ...(msg && msg.tableLabels ? msg.tableLabels : {})
});

const hasCompareFiles = computed(
    () =>
        !!compareFile.value ||
        (!!dualFileA.value && !!dualFileB.value)
);
const messages = ref([]);
const metaLine = ref("");
const scrollRef = ref(null);
let msgSeq = 1;
const nextId = () => {
    msgSeq += 1;
    return msgSeq;
};

const sourceLabel = (s) => {
    if (!s) return "向量";
    if (String(s).includes("keyword")) return "关键字";
    if (String(s).includes("hybrid")) return "混合";
    if (String(s).includes("acl_fallback")) return "兜底";
    return "向量";
};

const sourceTagType = (s) => {
    const x = String(s || "");
    if (x.includes("keyword")) return "warning";
    if (x.includes("hybrid")) return "success";
    if (x.includes("acl_fallback")) return "danger";
    return "info";
};

const copyHitPath = async (row) => {
    const text = hitCopyPath(row);
    if (!text) {
        ElMessage.warning("无可用路径");
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        ElMessage.success("已复制路径");
    } catch {
        ElMessage.error("复制失败，请手动选择路径列复制");
    }
};

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

const clearKbFile = () => {
    compareFile.value = null;
    if (compareKbInputRef.value) compareKbInputRef.value.value = "";
};

const clearDualFiles = () => {
    dualFileA.value = null;
    dualFileB.value = null;
    if (compareDualInputRef.value) compareDualInputRef.value.value = "";
};

const onKbFilePicked = (e) => {
    const f = e?.target?.files?.[0];
    compareFile.value = f || null;
    if (e?.target) e.target.value = "";
};

const onDualFilesPicked = (e) => {
    const list = Array.from(e?.target?.files || []);
    if (e?.target) e.target.value = "";
    if (list.length !== 2) {
        ElMessage.warning("请一次选择恰好两个文件进行互相对比");
        dualFileA.value = null;
        dualFileB.value = null;
        return;
    }
    dualFileA.value = list[0];
    dualFileB.value = list[1];
};

const onAttachCommand = (cmd) => {
    if (cmd === "clear_files") {
        clearKbFile();
        clearDualFiles();
        return;
    }
    if (cmd === "kb_one") {
        clearDualFiles();
        nextTick(() => compareKbInputRef.value?.click());
        return;
    }
    if (cmd === "dual_two") {
        clearKbFile();
        nextTick(() => compareDualInputRef.value?.click());
    }
};

const downloadBlobFromBase64 = (base64, mime, filename) => {
    const b64 = String(base64 || "").trim();
    if (!b64) {
        ElMessage.warning("无可用文件数据，请重新执行一次对比");
        return;
    }
    try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        ElMessage.success("已开始下载");
    } catch {
        ElMessage.error("下载失败");
    }
};

const downloadCompareExcel = (msg) => {
    const base = (msg?.matchedTitle || "compare").replace(/[/\\?%*:|"<>]/g, "_");
    downloadBlobFromBase64(
        msg?.reportExcelBase64,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        `${base}-对比报告.xlsx`
    );
};

const downloadCompareWord = (msg) => {
    const base = (msg?.matchedTitle || "compare").replace(/[/\\?%*:|"<>]/g, "_");
    downloadBlobFromBase64(
        msg?.reportDocxBase64,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        `${base}-对比报告.docx`
    );
};

function renderMd(t) {
    if (!t || !String(t).trim()) return "";
    try {
        const raw = marked(String(t), { async: false });
        return DOMPurify.sanitize(raw);
    } catch {
        return DOMPurify.sanitize(`<pre>${escapeHtml(t)}</pre>`);
    }
}

function buildContextFromMessages(msgs) {
    const out = [];
    for (const m of msgs) {
        if (m.pending) continue;
        if (m.role === "user") {
            out.push({ role: "user", content: String(m.text || "").slice(0, 2000) });
        } else if (m.role === "assistant") {
            const c =
                String(m.text || "").trim() || String(m.ragDegradedHint || "").trim();
            if (c) out.push({ role: "assistant", content: c.slice(0, 2000) });
        }
    }
    return out.slice(-12);
}

function buildPipelineSteps(d, hits, q, opts) {
    const steps = [];
    const hybrid = d.hybrid !== false;
    steps.push(
        `① 查询预处理：用户问题已编码为向量，用于相似度检索。`
    );
    steps.push(
        `② 检索策略：${hybrid ? "混合检索（向量 Top 候选 + 库内关键字 scroll + RRF 融合）" : "仅向量检索"} · TopK=${opts.topK}`
    );
    if (d.adminAclBypass) steps.push(`③ 权限：管理员模式，未按部门过滤向量库。`);
    else if (d.aclFallbackUsed) steps.push(`③ 权限：主过滤无命中后启用「应用层部门兜底」二次召回。`);
    else steps.push(`③ 权限：按可见部门过滤 Qdrant 命中。`);
    steps.push(
        `④ 召回规模：向量候选约 ${d.vectorPoolSize ?? 0} 条 · 关键字扫描池约 ${d.keywordPoolSize ?? 0} 条`
    );
    steps.push(`⑤ 融合结果：本问最终进入模型的片段 ${hits.length} 条。`);
    if (hits.length) {
        hits.slice(0, 6).forEach((h, i) => {
            const prev = String(h.text_preview || "").replace(/\s+/g, " ").slice(0, 100);
            steps.push(
                `　· 片段 ${i + 1}《${h.file_name || "—"}》#${h.chunk_index} [${sourceLabel(h.retrievalSource)}] ${prev}${prev.length >= 100 ? "…" : ""}`
            );
        });
        if (hits.length > 6) steps.push(`　· … 其余 ${hits.length - 6} 条略`);
    }
    steps.push(
        `⑥ 生成：${opts.includeAnswer ? "将上述片段与（若有）多轮上下文一并送入品质 AI 模型生成答复。" : "未调用大模型，仅返回检索结果。"}`
    );
    return steps;
}

function persistSession() {
    try {
        const loginId = authStore.loginId || "";
        const slim = messages.value
            .filter((m) => !m.pending)
            .map((m) => ({
                id: m.id,
                role: m.role,
                text: m.text,
                metaLine: m.metaLine,
                hits: m.hits,
                ragDegradedHint: m.ragDegradedHint,
                pipelineSteps: m.pipelineSteps,
                wantedAnswer: m.wantedAnswer,
                searched: m.searched,
                _srcOpen: m._srcOpen,
                kind: m.kind,
                compareVariant: m.compareVariant,
                tableLabels: m.tableLabels,
                leftFileName: m.leftFileName,
                rightFileName: m.rightFileName,
                matchedTitle: m.matchedTitle,
                pagesLeftStr: m.pagesLeftStr,
                pagesRightStr: m.pagesRightStr,
                snippetMaxChars: m.snippetMaxChars,
                shortIntro: m.shortIntro,
                llmExplanation: m.llmExplanation,
                llmHint: m.llmHint,
                compareError: m.compareError,
                diffRows:
                    m.kind === "file_compare" && Array.isArray(m.diffRows)
                        ? m.diffRows.slice(0, 100)
                        : m.diffRows,
                diffRowsTotal: m.diffRowsTotal,
                diffRowsCapped: m.diffRowsCapped,
                _compareOpen: m._compareOpen
            }));
        sessionStorage.setItem(
            KB_CHAT_SESSION_KEY,
            JSON.stringify({ loginId, messages: slim })
        );
    } catch (_) {
        /* ignore */
    }
}

function loadSession() {
    try {
        const raw = sessionStorage.getItem(KB_CHAT_SESSION_KEY);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (o.loginId !== authStore.loginId || !Array.isArray(o.messages)) return;
        messages.value = o.messages.map((m) => ({
            ...m,
            _srcOpen: m._srcOpen || ["sources"],
            kind: m.kind,
            compareVariant: m.compareVariant,
            tableLabels: m.tableLabels,
            leftFileName: m.leftFileName,
            rightFileName: m.rightFileName,
            matchedTitle: m.matchedTitle,
            pagesLeftStr: m.pagesLeftStr,
            pagesRightStr: m.pagesRightStr,
            snippetMaxChars: m.snippetMaxChars,
            shortIntro: m.shortIntro,
            llmExplanation: m.llmExplanation,
            llmHint: m.llmHint,
            compareError: m.compareError,
            diffRows: m.diffRows,
            diffRowsTotal: m.diffRowsTotal,
            diffRowsCapped: m.diffRowsCapped,
            _compareOpen: Array.isArray(m._compareOpen) ? m._compareOpen : []
        }));
        const maxId = messages.value.reduce((a, m) => Math.max(a, m.id || 0), 0);
        if (maxId) msgSeq = maxId;
    } catch (_) {
        /* ignore */
    }
}

function loadSearchPrefs() {
    try {
        const raw = sessionStorage.getItem(KB_SEARCH_PREFS_KEY);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (o.loginId !== authStore.loginId) return;
        const n = (x, lo, hi, def) => {
            const v = Number(x);
            return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
        };
        if (typeof o.topK === "number") form.topK = n(o.topK, 1, 50, form.topK);
        if (typeof o.hybrid === "boolean") form.hybrid = o.hybrid;
        if (typeof o.includeAnswer === "boolean") form.includeAnswer = o.includeAnswer;
        if (typeof o.deepThink === "boolean") form.deepThink = o.deepThink;
        if (typeof o.debugSources === "boolean") form.debugSources = o.debugSources;
    } catch (_) {
        /* ignore */
    }
}

function persistSearchPrefs() {
    try {
        sessionStorage.setItem(
            KB_SEARCH_PREFS_KEY,
            JSON.stringify({
                loginId: authStore.loginId || "",
                topK: form.topK,
                hybrid: form.hybrid,
                includeAnswer: form.includeAnswer,
                deepThink: form.deepThink,
                debugSources: form.debugSources
            })
        );
    } catch (_) {
        /* ignore */
    }
}

const scrollToBottom = async () => {
    await nextTick();
    const w = scrollRef.value?.wrapRef;
    if (w) w.scrollTop = w.scrollHeight;
};

watch(
    messages,
    () => {
        scrollToBottom();
        persistSession();
    },
    { deep: true }
);

watch(
    () => ({
        topK: form.topK,
        hybrid: form.hybrid,
        includeAnswer: form.includeAnswer,
        deepThink: form.deepThink,
        debugSources: form.debugSources
    }),
    () => persistSearchPrefs(),
    { deep: true }
);

onMounted(() => {
    loadSearchPrefs();
    loadSession();
});

function onComposerKeydown(e) {
    if (e.key !== "Enter") return;
    if (e.shiftKey) return;
    if (e.isComposing) return;
    e.preventDefault();
    onSearch();
}

const buildCompareAssistantMsg = (assistantId, d) => ({
    id: assistantId,
    role: "assistant",
    pending: false,
    pendingCompare: false,
    kind: "file_compare",
    compareVariant: d.compareVariant || "kb_same",
    tableLabels: d.tableLabels || null,
    leftFileName: d.leftFileName || "",
    rightFileName: d.rightFileName || "",
    shortIntro: d.shortIntro || "",
    llmExplanation: d.llmExplanation || "",
    llmHint: d.llmHint || "",
    matchedTitle: d.matchedTitle,
    pagesLeftStr: d.pagesLeftStr || "",
    pagesRightStr: d.pagesRightStr || "",
    snippetMaxChars: d.snippetMaxChars,
    diffRows: Array.isArray(d.diffRows) ? d.diffRows : [],
    diffRowsTotal: d.diffRowsTotal ?? 0,
    diffRowsCapped: !!d.diffRowsCapped,
    reportExcelBase64: d.reportExcelBase64 || "",
    reportDocxBase64: d.reportDocxBase64 || "",
    compareError: "",
    text: "",
    hits: [],
    _srcOpen: [],
    _compareOpen: []
});

const onSearch = async () => {
    const q = form.query.trim();
    if (sending.value) return;

    if (dualFileA.value && dualFileB.value) {
        form.query = "";
        const userLabel =
            q ||
            `比对本地文件「${dualFileA.value.name}」与「${dualFileB.value.name}」`;
        const userMsg = { id: nextId(), role: "user", text: userLabel };
        const assistantId = nextId();
        const assistantPlaceholder = {
            id: assistantId,
            role: "assistant",
            pending: true,
            pendingCompare: true,
            text: "",
            hits: [],
            _srcOpen: []
        };
        messages.value.push(userMsg);
        messages.value.push(assistantPlaceholder);
        sending.value = true;
        metaLine.value = "两文件差异对比";

        try {
            const fd = new FormData();
            fd.append("fileA", dualFileA.value, dualFileA.value.name);
            fd.append("fileB", dualFileB.value, dualFileB.value.name);
            const res = await api.post("/search/compare-two-files", fd, {
                timeout: 180000
            });
            if (res.data?.code !== 200) throw new Error(res.data?.msg || "对比失败");
            const d = res.data?.data || {};
            const idx = messages.value.findIndex((m) => m.id === assistantId);
            if (idx >= 0) {
                messages.value[idx] = buildCompareAssistantMsg(assistantId, d);
            }
            clearDualFiles();
        } catch (e) {
            const errText = String(e?.response?.data?.msg || e?.message || "对比失败");
            ElMessage.error(errText);
            const idx = messages.value.findIndex((m) => m.id === assistantId);
            if (idx >= 0) {
                messages.value[idx] = {
                    id: assistantId,
                    role: "assistant",
                    pending: false,
                    pendingCompare: false,
                    kind: "file_compare",
                    compareVariant: "two_files",
                    tableLabels: null,
                    leftFileName: "",
                    rightFileName: "",
                    shortIntro: "",
                    llmExplanation: "",
                    llmHint: "",
                    matchedTitle: "",
                    diffRows: [],
                    diffRowsTotal: 0,
                    diffRowsCapped: false,
                    reportExcelBase64: "",
                    reportDocxBase64: "",
                    compareError: `对比失败：${errText}`,
                    text: "",
                    hits: [],
                    _srcOpen: [],
                    _compareOpen: []
                };
            }
        } finally {
            sending.value = false;
        }
        return;
    }

    if (compareFile.value) {
        form.query = "";
        const userLabel =
            q || `比对附件「${compareFile.value.name}」与知识库中同名已索引文件`;
        const userMsg = { id: nextId(), role: "user", text: userLabel };
        const assistantId = nextId();
        const assistantPlaceholder = {
            id: assistantId,
            role: "assistant",
            pending: true,
            pendingCompare: true,
            text: "",
            hits: [],
            _srcOpen: []
        };
        messages.value.push(userMsg);
        messages.value.push(assistantPlaceholder);
        sending.value = true;
        metaLine.value = "文件差异对比（知识库同名）";

        try {
            const fd = new FormData();
            fd.append("file", compareFile.value, compareFile.value.name);
            const res = await api.post("/search/compare-file", fd, {
                timeout: 180000
            });
            if (res.data?.code !== 200) throw new Error(res.data?.msg || "对比失败");
            const d = res.data?.data || {};
            const idx = messages.value.findIndex((m) => m.id === assistantId);
            if (idx >= 0) {
                messages.value[idx] = buildCompareAssistantMsg(assistantId, d);
            }
            clearKbFile();
        } catch (e) {
            const errText = String(e?.response?.data?.msg || e?.message || "对比失败");
            ElMessage.error(errText);
            const idx = messages.value.findIndex((m) => m.id === assistantId);
            if (idx >= 0) {
                messages.value[idx] = {
                    id: assistantId,
                    role: "assistant",
                    pending: false,
                    pendingCompare: false,
                    kind: "file_compare",
                    compareVariant: "kb_same",
                    tableLabels: null,
                    leftFileName: "",
                    rightFileName: "",
                    shortIntro: "",
                    llmExplanation: "",
                    llmHint: "",
                    matchedTitle: "",
                    diffRows: [],
                    diffRowsTotal: 0,
                    diffRowsCapped: false,
                    reportExcelBase64: "",
                    reportDocxBase64: "",
                    compareError: `对比失败：${errText}`,
                    text: "",
                    hits: [],
                    _srcOpen: [],
                    _compareOpen: []
                };
            }
        } finally {
            sending.value = false;
        }
        return;
    }

    if (!q) {
        ElMessage.warning("请输入问题");
        return;
    }

    form.query = "";

    const conversationContext = buildContextFromMessages(messages.value);

    const userMsg = { id: nextId(), role: "user", text: q };
    const assistantId = nextId();
    const assistantPlaceholder = {
        id: assistantId,
        role: "assistant",
        pending: true,
        text: "",
        hits: [],
        _srcOpen: ["sources"]
    };

    messages.value.push(userMsg);
    messages.value.push(assistantPlaceholder);

    sending.value = true;
    metaLine.value = "";

    try {
        const res = await api.post(
            "/search",
            {
                query: q,
                topK: form.topK,
                hybrid: form.hybrid,
                includeAnswer: form.includeAnswer,
                includeRag: form.includeAnswer,
                conversationContext
            },
            {
                /* 混合检索会 scroll Qdrant + 向量化 + 可选 RAG，默认 30s 易超时 */
                timeout: 180000
            }
        );

        if (res.data?.code !== 200) throw new Error(res.data?.msg || "检索失败");

        const d = res.data?.data || {};
        const hits = d.hits || [];

        const parts = [];
        if (d.hybrid === false) parts.push("纯向量");
        else parts.push("混合检索");
        if (typeof d.vectorPoolSize === "number") parts.push(`向量候选 ${d.vectorPoolSize}`);
        if (typeof d.keywordPoolSize === "number") parts.push(`关键字池 ${d.keywordPoolSize}`);
        metaLine.value = parts.join(" · ");

        let ragText = "";
        const rag = d.rag;
        if (rag && typeof rag.answer === "string" && rag.answer.trim()) {
            ragText = rag.answer;
        } else if (rag && typeof rag === "string") {
            ragText = rag;
        }

        let ragDegradedHint = "";
        const rm = d.ragMeta;
        if (rm && rm.degraded && typeof rm.hint === "string") {
            ragDegradedHint = rm.hint;
        }

        const pipelineSteps = buildPipelineSteps(d, hits, q, {
            topK: form.topK,
            includeAnswer: form.includeAnswer
        });

        const idx = messages.value.findIndex((m) => m.id === assistantId);
        if (idx >= 0) {
            messages.value[idx] = {
                id: assistantId,
                role: "assistant",
                pending: false,
                text: ragText,
                hits,
                ragDegradedHint,
                metaLine: metaLine.value,
                pipelineSteps,
                wantedAnswer: form.includeAnswer,
                searched: true,
                _srcOpen: ["sources"]
            };
        }
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "检索失败");
        const idx = messages.value.findIndex((m) => m.id === assistantId);
        if (idx >= 0) {
            messages.value[idx] = {
                id: assistantId,
                role: "assistant",
                pending: false,
                text: "",
                hits: [],
                ragDegradedHint: e?.response?.data?.msg || e?.message || "检索失败",
                searched: true,
                wantedAnswer: form.includeAnswer,
                pipelineSteps: [],
                _srcOpen: ["sources"]
            };
        }
    } finally {
        sending.value = false;
    }
};
</script>

<style scoped>
.chat-shell {
    width: 100%;
    max-width: none;
    margin: 0;
    min-height: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--kb-bg-page, #f0f2f5);
    border: none;
    border-radius: 0;
    overflow: hidden;
}

.search-meta {
    flex-shrink: 0;
    margin: 0;
    padding: 8px 20px 0;
    font-size: 12px;
    color: var(--kb-text-secondary, #666);
    box-sizing: border-box;
}

.scroll-area {
    flex: 1;
    min-height: 0;
    padding: 12px 20px 16px;
    background: transparent;
    box-sizing: border-box;
}

.chat-flow {
    display: flex;
    flex-direction: column;
    gap: 18px;
    align-items: stretch;
}

.welcome {
    padding: 20px 12px;
    text-align: center;
    color: var(--kb-text-secondary, #666);
    font-size: 14px;
    line-height: 1.7;
}

.welcome-title {
    font-weight: 600;
    color: var(--kb-text-title, #1a1a1a);
    margin: 0 0 8px;
}

.welcome-example {
    margin: 0 0 12px;
    color: var(--kb-text-title, #1a1a1a);
}

.welcome-hint {
    margin: 0 auto;
    font-size: 13px;
    max-width: 560px;
}

.turn {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 92%;
}

.turn--user {
    align-self: flex-end;
    align-items: flex-end;
    max-width: 85%;
}

.turn--assistant {
    align-self: flex-start;
    align-items: flex-start;
}

.role {
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
    letter-spacing: 0.04em;
}

.role-user {
    text-align: right;
    width: 100%;
}

.role-assistant {
    color: var(--kb-color-primary, #1890ff);
}

.bubble {
    padding: 12px 16px;
    border-radius: 14px;
    line-height: 1.65;
    font-size: 14px;
    word-break: break-word;
}

.bubble.user {
    background: linear-gradient(135deg, #e8f4ff 0%, #f0f7ff 100%);
    border: 1px solid #b3d8ff;
    color: var(--kb-text-title, #1a1a1a);
    box-shadow: 0 1px 4px rgba(24, 144, 255, 0.12);
}

.bubble.assistant {
    background: var(--kb-bg-card, #fff);
    border: 1px solid var(--kb-border, #e8e8e8);
    box-shadow: var(--kb-shadow-card, 0 1px 4px rgba(0, 0, 0, 0.06));
}

.bubble.muted {
    color: var(--kb-text-secondary, #666);
    font-size: 13px;
    border-style: dashed;
}

.think-wrap {
    width: 100%;
    margin-bottom: 8px;
    background: var(--kb-bg-card, #fff);
    border: 1px solid var(--kb-border, #e8e8e8);
    border-radius: 10px;
    overflow: hidden;
}

.think-title {
    font-weight: 600;
    color: var(--kb-text-title, #1a1a1a);
    font-size: 13px;
}

.think-steps {
    margin: 0;
    padding-left: 1.2rem;
    font-size: 12px;
    color: var(--kb-text-secondary, #595959);
    line-height: 1.7;
}

.think-steps li {
    margin-bottom: 6px;
}

.answer-md :deep(h2) {
    font-size: 15px;
    margin: 14px 0 8px;
    color: var(--kb-text-title, #1a1a1a);
    font-weight: 600;
}

.answer-md :deep(h1) {
    font-size: 16px;
    margin: 0 0 10px;
    color: var(--kb-text-title, #1a1a1a);
}

.answer-md :deep(p) {
    margin: 0 0 10px;
    color: var(--kb-text-secondary, #262626);
}

.answer-md :deep(ul),
.answer-md :deep(ol) {
    margin: 0 0 10px;
    padding-left: 1.25rem;
    color: var(--kb-text-secondary, #262626);
}

.answer-md :deep(li) {
    margin-bottom: 4px;
}

.answer-md :deep(code) {
    background: #f5f5f5;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 0.9em;
}

.answer-md :deep(pre) {
    background: #262626;
    color: #f5f5f5;
    padding: 12px;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 13px;
}

.answer-md :deep(pre code) {
    background: transparent;
    padding: 0;
    color: inherit;
}

.sources-wrap {
    width: 100%;
    margin-top: 10px;
    background: var(--kb-bg-card, #fff);
    border-radius: 10px;
    border: 1px solid var(--kb-border, #e8e8e8);
    overflow: hidden;
    box-shadow: var(--kb-shadow-card, 0 1px 4px rgba(0, 0, 0, 0.06));
}

.collapse-title {
    font-weight: 600;
    color: var(--kb-text-title, #1a1a1a);
}

.src-table {
    width: 100%;
}

.th-tip {
    cursor: help;
    border-bottom: 1px dotted var(--kb-text-secondary, #999);
}

.score-footnote {
    margin: 8px 12px 12px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--kb-text-secondary, #666);
}

.score-footnote code {
    font-size: 11px;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--kb-bg-muted, #f5f5f5);
}

.hidden-compare-input {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
    pointer-events: none;
}

.composer-text-wrap {
    margin-bottom: 10px;
}

.fab-ic {
    margin-right: 6px;
    vertical-align: middle;
}

.attach-inline-btn {
    font-weight: 600;
    box-shadow: 0 2px 10px rgba(24, 144, 255, 0.28);
}

.compare-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    font-size: 12px;
}

.chip-label {
    color: var(--kb-text-secondary, #666);
    margin-right: 4px;
}

.hit-path-dbl {
    cursor: copy;
    user-select: text;
}

.compare-intro {
    margin: 0 0 10px;
    font-size: 14px;
    line-height: 1.65;
    color: var(--kb-text-title, #262626);
}

.compare-hint {
    margin: 0 0 10px;
    padding: 8px 10px;
    font-size: 13px;
    line-height: 1.55;
    color: #ad6800;
    background: #fffbe6;
    border: 1px solid #ffe58f;
    border-radius: 8px;
}

.compare-section {
    margin-bottom: 12px;
}

.compare-section-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--kb-text-title, #1a1a1a);
    margin-bottom: 6px;
}

.compare-plain {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 14px;
    line-height: 1.7;
    color: var(--kb-text-secondary, #262626);
    padding: 10px 12px;
    background: #fafafa;
    border-radius: 8px;
    border: 1px solid #f0f0f0;
}

.compare-error {
    color: #cf1322;
    background: #fff2f0;
    border-color: #ffccc7;
}

.compare-muted {
    font-size: 13px;
    color: #8c8c8c;
    margin-bottom: 10px;
}

.compare-collapse {
    margin: 12px 0;
    width: 100%;
}

.compare-table {
    width: 100%;
}

.compare-cap {
    margin: 8px 0 0;
    font-size: 12px;
    color: #8c8c8c;
}

.compare-dl-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 12px;
}

.compare-dl-hint {
    margin-top: 6px;
    margin-bottom: 0;
}

.composer {
    flex-shrink: 0;
    padding: 12px 20px 16px;
    background: var(--kb-bg-card, #fff);
    border-top: 1px solid var(--kb-border, #e8e8e8);
}

.q-input :deep(.el-textarea__inner) {
    border-radius: 10px;
    font-size: 14px;
}

.composer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-top: 8px;
    flex-wrap: wrap;
}

.composer-bar-left {
    flex: 1 1 auto;
    min-width: 0;
}

.composer-bar-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
}

.switches {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
}

.sw-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--kb-text-secondary, #666);
}

.topk-wrap {
    display: inline-flex;
    align-items: center;
    gap: 8px;
}

.topk-label {
    font-size: 12px;
    color: var(--kb-text-secondary, #666);
}

.send-btn {
    min-width: 88px;
    border-radius: 8px;
}

.composer-hint {
    margin: 8px 0 0;
    font-size: 11px;
    color: #8c8c8c;
}
</style>
