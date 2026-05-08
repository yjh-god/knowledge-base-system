<template>
    <div class="kb-page">
        <el-card class="kb-card">
            <p class="kb-section-title">上传文件或文件夹</p>

            <div class="upload-two-col">
                <div class="upload-col upload-col-dept">
                    <div class="dept-scope-section">
                        <div class="dept-scope-head">
                            <span class="dept-scope-title">可检索部门</span>
                            <span class="dept-scope-meta">
                                已选 {{ uploadForm.visibleDeptIds.length }} 个 · 点击箭头展开子级，勾选可多选并列部门
                            </span>
                        </div>
                        <p class="dept-scope-hint">
                            决定文档检索可见范围；父子勾选互不影响，便于同时选多个不同分支。
                        </p>
                        <div v-loading="deptTreeLoading" class="dept-tree-panel">
                            <el-tree
                                v-if="deptTreeData.length"
                                :key="deptTreeRenderKey"
                                ref="deptTreeRef"
                                :data="deptTreeData"
                                show-checkbox
                                check-strictly
                                node-key="id"
                                :props="{ label: 'label', children: 'children' }"
                                :default-expanded-keys="deptExpandedKeys"
                                :expand-on-click-node="false"
                                highlight-current
                                :indent="18"
                                class="dept-tree"
                                @check="onDeptTreeCheck"
                            >
                                <template #default="{ node }">
                                    <span class="dept-tree-node">
                                        <el-icon class="dept-tree-folder"><Folder /></el-icon>
                                        <span class="dept-tree-label">{{ node.label }}</span>
                                    </span>
                                </template>
                            </el-tree>
                            <div v-else-if="!deptTreeLoading" class="dept-tree-empty">
                                暂无部门数据，请先同步 EHR 或检查接口
                            </div>
                        </div>
                        <div class="dept-scope-actions">
                            <el-button text type="primary" size="small" @click="clearDeptSelection">
                                清除部门勾选
                            </el-button>
                        </div>
                        <div class="dept-include-row">
                            <el-checkbox v-model="uploadForm.deptScopeIncludeChildren" size="small">
                                已选部门<strong>含全部下级</strong>（按组织树展开后写入向量可见范围，PRD 含下级）
                            </el-checkbox>
                        </div>
                        <div v-if="isAdmin" class="dept-include-row">
                            <el-checkbox v-model="uploadForm.deptScopeCompanyWide" size="small">
                                <strong>全公司可见</strong>（管理员专用：<code>visible_department_ids</code> 写入
                                <code>*</code>，无需勾选部门）
                            </el-checkbox>
                        </div>

                        <el-divider content-position="left" class="dept-cat-divider"
                            >文件类属部门（知识图谱分类）</el-divider
                        >
                        <p class="dept-scope-hint">
                            用于后续按部门维度做知识图谱等分类；默认与「可检索部门」一致。入库后标题仍为原始文件名，磁盘路径为
                            <code>uploads/文档ID/文件名</code>（UTF-8）。
                        </p>
                        <div class="dept-include-row">
                            <el-checkbox v-model="uploadForm.categorySameAsVisible" size="small">
                                类属部门与可检索部门<strong>相同</strong>
                            </el-checkbox>
                        </div>
                        <template v-if="!uploadForm.categorySameAsVisible && !uploadForm.deptScopeCompanyWide">
                            <div class="dept-scope-head dept-cat-head">
                                <span class="dept-scope-title">类属部门</span>
                                <span class="dept-scope-meta">
                                    已选 {{ uploadForm.categoryDeptIds.length }} 个（可与检索范围不同）
                                </span>
                            </div>
                            <div v-loading="deptTreeLoading" class="dept-tree-panel dept-tree-panel--compact">
                                <el-tree
                                    v-if="deptTreeData.length"
                                    :key="'cat-' + deptTreeRenderKey"
                                    ref="deptCategoryTreeRef"
                                    :data="deptTreeData"
                                    show-checkbox
                                    check-strictly
                                    node-key="id"
                                    :props="{ label: 'label', children: 'children' }"
                                    :default-expanded-keys="deptExpandedKeys"
                                    :expand-on-click-node="false"
                                    highlight-current
                                    :indent="18"
                                    class="dept-tree"
                                    @check="onCategoryTreeCheck"
                                >
                                    <template #default="{ node }">
                                        <span class="dept-tree-node">
                                            <el-icon class="dept-tree-folder"><Folder /></el-icon>
                                            <span class="dept-tree-label">{{ node.label }}</span>
                                        </span>
                                    </template>
                                </el-tree>
                            </div>
                            <div class="dept-include-row">
                                <el-checkbox v-model="uploadForm.categoryDeptScopeIncludeChildren" size="small">
                                    类属部门含全部下级
                                </el-checkbox>
                            </div>
                        </template>
                    </div>
                </div>

                <div class="upload-col upload-col-files">
                    <div
                        class="upload-box"
                        v-loading="uploadPhase !== 'idle'"
                        element-loading-text="处理中，请勿关闭页面…"
                    >
                <div v-if="uploadPhase !== 'idle'" class="progress-block">
                    <div v-if="uploadPhase === 'uploading'" class="progress-row">
                        <div class="progress-label">正在上传文件…</div>
                        <el-progress :percentage="uploadProgress" :stroke-width="10" />
                    </div>
                    <div v-if="uploadPhase === 'processing'" class="progress-row">
                        <div class="progress-label">后端处理中（切分 / 向量化）…</div>
                        <el-progress
                            :percentage="processProgress"
                            :status="processBarStatus"
                            :stroke-width="10"
                        />
                        <div class="progress-hint">{{ processHint }}</div>
                    </div>
                </div>
                <div class="upload-actions">
                    <el-button :disabled="uploadPhase !== 'idle'" @click="triggerPickFiles">选择文件</el-button>
                    <el-button :disabled="uploadPhase !== 'idle'" @click="triggerPickFolder">选择文件夹</el-button>
                    <span class="upload-hint"
                        >支持：.txt/.md/.html/.xlsx/.xls/.pdf/.docx/.pptx 等（与解析器一致）</span
                    >
                </div>

                <div v-if="selectedFiles.length" class="selected-meta">
                    已选 {{ selectedFiles.length }} 个文件
                </div>

                <div v-if="selectedFiles.length" class="selected-list">
                    <div
                        v-for="(f, idx) in selectedFiles.slice(0, 12)"
                        :key="(f.webkitRelativePath || f.name) + '-' + idx"
                        class="selected-item"
                    >
                        {{ f.webkitRelativePath || f.name }}
                    </div>
                    <div v-if="selectedFiles.length > 12" class="selected-item muted">
                        还有 {{ selectedFiles.length - 12 }} 个文件未显示
                    </div>
                </div>

                <el-collapse class="kg-upload-collapse" accordion>
                    <el-collapse-item title="知识图谱元数据（可选，写入文档与向量块 payload）" name="kg">
                        <div class="kg-upload-grid">
                            <el-select
                                v-model="uploadForm.knowledgeType"
                                placeholder="业务类型 knowledge_type"
                                clearable
                                class="kg-field"
                            >
                                <el-option label="FAQ" value="FAQ" />
                                <el-option label="制度" value="制度" />
                                <el-option label="方案" value="方案" />
                                <el-option label="文档" value="文档" />
                            </el-select>
                            <el-input
                                v-model="uploadForm.author"
                                placeholder="作者 author"
                                clearable
                                class="kg-field"
                            />
                            <el-input
                                v-model="uploadForm.docVersion"
                                placeholder="版本号 version"
                                clearable
                                class="kg-field"
                            />
                            <el-input
                                v-model="uploadForm.sourceUri"
                                placeholder="来源链接或说明 source"
                                clearable
                                class="kg-field"
                            />
                            <el-input
                                v-model="uploadForm.departmentCaption"
                                placeholder="所属部门展示文案 department"
                                clearable
                                class="kg-field kg-field-wide"
                            />
                        </div>
                        <p class="kg-upload-hint">
                            入库后可在「管理后台 → 知识图谱」查看类型定义；向量点含
                            <code>content</code>、<code>doc_id</code>、<code>title</code> 等字段。
                        </p>
                    </el-collapse-item>
                </el-collapse>

                <div class="upload-submit">
                    <el-button
                        type="primary"
                        :loading="uploadPhase === 'uploading'"
                        :disabled="selectedFiles.length === 0 || uploadPhase !== 'idle'"
                        @click="onUpload"
                    >
                        上传并入库
                    </el-button>
                    <el-button text :disabled="uploadPhase !== 'idle'" @click="clearSelected">清空</el-button>
                </div>
                    </div>
                </div>
            </div>

            <input ref="fileInputRef" type="file" class="hidden-input" multiple @change="onPickFiles" />
            <input
                ref="dirInputRef"
                type="file"
                class="hidden-input"
                webkitdirectory
                directory
                multiple
                @change="onPickFolder"
            />

            <el-divider class="kb-divider" content-position="left">文档列表</el-divider>

            <el-table
                v-loading="listLoading"
                :data="items"
                class="kb-table"
                stripe
                border
                style="width: 100%"
            >
                <el-table-column
                    type="index"
                    label="序号"
                    width="68"
                    align="center"
                    :index="docRowIndex"
                />
                <el-table-column label="更新时间" min-width="168">
                    <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
                </el-table-column>
                <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
                <el-table-column min-width="260" show-overflow-tooltip>
                    <template #header>
                        <span title="双击下方路径文本可复制">文件绝对路径</span>
                    </template>
                    <template #default="{ row }">
                        <div v-if="row.absolutePath" class="path-cell-wrap">
                            <span
                                class="path-cell path-cell--copy"
                                title="双击复制完整路径"
                                @dblclick="copyText(row.absolutePath, '路径')"
                                >{{ row.absolutePath }}</span
                            >
                        </div>
                        <span
                            v-else-if="row.storageKey"
                            class="path-cell path-cell--muted path-cell--copy"
                            title="双击复制 storage_key"
                            @dblclick="copyText(row.storageKey, '路径')"
                            >{{ row.storageKey }}</span
                        >
                        <span v-else class="doc-dash">—</span>
                    </template>
                </el-table-column>
                <el-table-column label="可检索部门" min-width="168" show-overflow-tooltip>
                    <template #default="{ row }">
                        <span v-if="row.deptScopeCompanyWide">全公司</span>
                        <span v-else-if="row.visibleDeptLabels">{{ row.visibleDeptLabels }}</span>
                        <span v-else class="doc-dash">—</span>
                    </template>
                </el-table-column>
                <el-table-column label="文件类属部门" min-width="140" show-overflow-tooltip>
                    <template #default="{ row }">
                        <span v-if="row.deptScopeCompanyWide">全公司</span>
                        <span v-else-if="row.categoryDeptLabels">{{ row.categoryDeptLabels }}</span>
                        <span v-else class="doc-dash">—</span>
                    </template>
                </el-table-column>
                <el-table-column label="向量化参数" min-width="200">
                    <template #default="{ row }">
                        <el-tooltip
                            v-if="formatIndexMetaLine(row)"
                            :content="formatIndexMetaDetail(row)"
                            placement="top"
                            :show-after="300"
                        >
                            <span class="index-meta-cell">{{ formatIndexMetaLine(row) }}</span>
                        </el-tooltip>
                        <span v-else class="doc-dash">—</span>
                    </template>
                </el-table-column>
                <el-table-column label="状态" width="104" align="center">
                    <template #default="{ row }">
                        <el-tag :type="docStatusTag(row.status)" size="small" effect="light">
                            {{ formatDocStatus(row.status) }}
                        </el-tag>
                    </template>
                </el-table-column>
                <el-table-column label="类型" width="88" align="center">
                    <template #default="{ row }">
                        <el-tooltip
                            v-if="row.mimeType"
                            :content="row.mimeType"
                            placement="top"
                            :show-after="300"
                        >
                            <span class="type-badge">{{ formatMimeShort(row.mimeType) }}</span>
                        </el-tooltip>
                        <span v-else>—</span>
                    </template>
                </el-table-column>
                <el-table-column label="大小" width="100" align="right">
                    <template #default="{ row }">
                        <span class="size-cell">{{ formatFileSize(row.sizeBytes) }}</span>
                    </template>
                </el-table-column>
                <el-table-column label="入库耗时" width="112" align="right">
                    <template #header>
                        <span title="最近一次成功入库（即时上传任务）从开始到结束耗时">入库耗时</span>
                    </template>
                    <template #default="{ row }">
                        <span
                            v-if="row.ingestDurationMs != null"
                            :title="`${row.ingestDurationMs} ms`"
                            >{{ formatIngestDuration(row.ingestDurationMs) }}</span
                        >
                        <span v-else class="doc-dash">—</span>
                    </template>
                </el-table-column>
                <el-table-column label="操作" width="156" fixed="right" align="center">
                    <template #default="{ row }">
                        <el-button
                            v-if="row.status !== 'deleted'"
                            type="primary"
                            text
                            size="small"
                            @click="onReindex(row)"
                        >
                            重新入库
                        </el-button>
                        <el-button type="danger" text size="small" @click="onDelete(row)">删除</el-button>
                    </template>
                </el-table-column>
            </el-table>

            <div v-if="!listLoading && items.length === 0" class="empty">暂无文档</div>
        </el-card>
    </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Folder } from "@element-plus/icons-vue";

import { api } from "../lib/api";
import { formatDateTime } from "../lib/datetimeFormat";
import {
    formatMimeShort,
    formatFileSize,
    formatDocStatus,
    formatIngestDuration
} from "../lib/displayFormat";
import { useAuthStore } from "../stores/auth";

import { ElMessage, ElMessageBox } from "element-plus";

const authStore = useAuthStore();
const isAdmin = computed(() => String(authStore.role || "").toLowerCase() === "admin");

const copyText = async (text, label) => {
    const t = String(text || "").trim();
    if (!t) {
        ElMessage.warning("无可复制内容");
        return;
    }
    try {
        await navigator.clipboard.writeText(t);
        ElMessage.success(`已复制${label || "内容"}`);
    } catch {
        ElMessage.error("复制失败，请手动选择复制");
    }
};

const docStatusTag = (s) => {
    if (s === "indexed") return "success";
    if (s === "pending_index") return "warning";
    if (s === "failed") return "danger";
    if (s === "deleted" || s === "disabled") return "info";
    return "";
};

/** 表格内一行摘要：维度 / 块数 / Batch */
const formatIndexMetaLine = (row) => {
    if (!row || typeof row !== "object") return "";
    const parts = [];
    if (row.vectorDim != null) parts.push(`维${row.vectorDim}`);
    if (row.chunkCount != null) parts.push(`${row.chunkCount}块`);
    if (row.embeddingBatchSize != null) parts.push(`批${row.embeddingBatchSize}`);
    return parts.length ? parts.join(" · ") : "";
};

const formatIndexMetaDetail = (row) => {
    if (!row || typeof row !== "object") return "";
    const lines = [];
    if (row.vectorDim != null) lines.push(`向量维度: ${row.vectorDim}`);
    if (row.chunkCount != null) lines.push(`文本块数: ${row.chunkCount}`);
    if (row.embeddingBatchSize != null) lines.push(`Embedding Batch Size: ${row.embeddingBatchSize}`);
    if (row.chunkSize != null) lines.push(`分块大小 chunkSize: ${row.chunkSize}`);
    if (row.chunkOverlap != null) lines.push(`重叠 chunkOverlap: ${row.chunkOverlap}`);
    if (row.embeddingModel) lines.push(`模型: ${row.embeddingModel}`);
    return lines.length ? lines.join("\n") : "—";
};

const items = ref([]);
const docListPage = ref(1);
const docListPageSize = ref(50);
const docRowIndex = (i) => (docListPage.value - 1) * docListPageSize.value + i + 1;
const listLoading = ref(false);
const deptTreeLoading = ref(false);
const deptTreeData = ref([]);
const deptExpandedKeys = ref([]);
const deptTreeRenderKey = ref(0);
const deptTreeRef = ref(null);
const deptCategoryTreeRef = ref(null);

/** idle | uploading | processing */
const uploadPhase = ref("idle");
const uploadProgress = ref(0);
const processProgress = ref(0);
const processHint = ref("");
const pollTimer = ref(null);

const processBarStatus = computed(() => {
    if (uploadPhase.value !== "processing") return "";
    if (processProgress.value >= 100) return "success";
    return "";
});

const uploadForm = ref({
    visibleDeptIds: [],
    deptScopeIncludeChildren: false,
    deptScopeCompanyWide: false,
    categorySameAsVisible: true,
    categoryDeptIds: [],
    categoryDeptScopeIncludeChildren: false,
    knowledgeType: "",
    author: "",
    docVersion: "",
    sourceUri: "",
    departmentCaption: ""
});

const selectedFiles = ref([]);
const fileInputRef = ref(null);
const dirInputRef = ref(null);

const load = async () => {
    listLoading.value = true;
    try {
        const res = await api.get("/documents", {
            params: { page: docListPage.value, pageSize: docListPageSize.value }
        });
        const d = res.data?.data;
        items.value = d?.items || [];
        if (d?.page != null) docListPage.value = Math.max(1, Number(d.page) || 1);
        if (d?.pageSize != null) docListPageSize.value = Math.max(1, Number(d.pageSize) || 50);
    } catch (e) {
        items.value = [];
        ElMessage.error(e?.response?.data?.msg || "加载列表失败");
    } finally {
        listLoading.value = false;
    }
};

const mapApiDeptToTree = (nodes) => {
    if (!nodes || !nodes.length) return [];
    return nodes.map((n) => ({
        id: String(n.id),
        label: n.name,
        children:
            n.children && n.children.length > 0 ? mapApiDeptToTree(n.children) : undefined
    }));
};

const onDeptTreeCheck = () => {
    const keys = deptTreeRef.value?.getCheckedKeys(false) || [];
    uploadForm.value.visibleDeptIds = keys.map((k) => String(k));
    if (uploadForm.value.categorySameAsVisible) {
        uploadForm.value.categoryDeptIds = [...uploadForm.value.visibleDeptIds];
        deptCategoryTreeRef.value?.setCheckedKeys(uploadForm.value.categoryDeptIds);
    }
};

const onCategoryTreeCheck = () => {
    const keys = deptCategoryTreeRef.value?.getCheckedKeys(false) || [];
    uploadForm.value.categoryDeptIds = keys.map((k) => String(k));
};

const clearDeptSelection = () => {
    uploadForm.value.visibleDeptIds = [];
    deptTreeRef.value?.setCheckedKeys([]);
    if (uploadForm.value.categorySameAsVisible) {
        uploadForm.value.categoryDeptIds = [];
        deptCategoryTreeRef.value?.setCheckedKeys([]);
    }
};

const loadDepts = async () => {
    deptTreeLoading.value = true;
    try {
        const res = await api.get("/departments");
        const departments = res.data?.data?.departments || [];
        deptTreeData.value = mapApiDeptToTree(departments);
        deptExpandedKeys.value = deptTreeData.value.map((d) => d.id);
        deptTreeRenderKey.value += 1;
        await nextTick();
        deptTreeRef.value?.setCheckedKeys(uploadForm.value.visibleDeptIds || []);
        if (uploadForm.value.categorySameAsVisible) {
            uploadForm.value.categoryDeptIds = [...uploadForm.value.visibleDeptIds];
        }
        deptCategoryTreeRef.value?.setCheckedKeys(uploadForm.value.categoryDeptIds || []);
    } catch (e) {
        deptTreeData.value = [];
        ElMessage.error(e?.response?.data?.msg || "加载部门树失败");
    } finally {
        deptTreeLoading.value = false;
    }
};

const triggerPickFiles = () => {
    fileInputRef.value?.click?.();
};

const triggerPickFolder = () => {
    dirInputRef.value?.click?.();
};

const onPickFiles = (e) => {
    const files = e?.target?.files ? Array.from(e.target.files) : [];
    selectedFiles.value = files;
    // 允许重复选择同一批文件
    if (e?.target) e.target.value = "";
};

const onPickFolder = (e) => {
    const files = e?.target?.files ? Array.from(e.target.files) : [];
    selectedFiles.value = files;
    if (e?.target) e.target.value = "";
};

const clearSelected = () => {
    selectedFiles.value = [];
    if (fileInputRef.value) fileInputRef.value.value = "";
    if (dirInputRef.value) dirInputRef.value.value = "";
};

const clearPoll = () => {
    if (pollTimer.value != null) {
        clearInterval(pollTimer.value);
        pollTimer.value = null;
    }
};

/** 将批次 errors 拼成多行文本，便于弹窗完整展示（含文件名前缀） */
const formatIngestErrorDetail = (errors) => {
    const errs = Array.isArray(errors) ? errors : [];
    const lines = errs
        .map((e) => {
            const fn = e?.fileName ? `[${e.fileName}] ` : "";
            const m = e?.errorMessage || e?.error_message || "";
            return m ? `${fn}${m}` : "";
        })
        .filter(Boolean);
    return lines.join("\n\n");
};

const pollBatchUntilDone = (batchId) => {
    clearPoll();
    const tick = async () => {
        try {
            /* 默认不加 debug=1，避免 Network 面板每秒刷屏；需要时在控制台执行：
               sessionStorage.setItem('kb_poll_ingest_debug','1') 后刷新页面 */
            const debugQs =
                typeof sessionStorage !== "undefined" &&
                sessionStorage.getItem("kb_poll_ingest_debug") === "1"
                    ? "?debug=1"
                    : "";
            const r = await api.get(`/documents/upload-batch/${batchId}${debugQs}`);
            if (r.data?.code !== 200) throw new Error(r.data?.msg || "查询进度失败");
            const d = r.data?.data || {};
            const total = Number(d.total) || 0;
            const finished = Number(d.finished) || 0;
            processProgress.value = Number(d.progressPercent) || 0;
            let hint = total ? `已完成 ${finished} / ${total}` : "";
            const idbg = d.ingestDebug;
            if (idbg && typeof idbg === "object") {
                const phase = idbg.phase || "-";
                const ch = Number(idbg.chunkCount) || 0;
                const vc = Number(idbg.embeddedTextsCount) || 0;
                const ep = idbg.embeddingBaseUrl ? " · embedding 已配置" : " · 未配置 EMBEDDING_API_BASE_URL";
                const b = idbg.batchId ? ` batch:${String(idbg.batchId).slice(0, 8)}…` : "";
                hint = `${hint || "排队/处理中"}${b} | 阶段:${phase} · 文本块:${ch} · 已向量:${vc}${ep}`;
                if (idbg.lastError) {
                    hint += ` | ${String(idbg.lastError).slice(0, 120)}`;
                }
            }
            processHint.value = hint;

            if (d.status !== "processing") {
                clearPoll();
                uploadPhase.value = "idle";
                uploadProgress.value = 0;
                processProgress.value = 0;
                processHint.value = "";

                if (d.status === "success") {
                    ElMessage.success({
                        message: "全部入库成功。可到左侧「检索」输入关键词试搜新文档。",
                        duration: 5000
                    });
                } else if (d.status === "partial") {
                    const fe = Array.isArray(d.errors) ? d.errors.length : 0;
                    ElMessage.warning({
                        message: `部分失败：成功 ${d.succeeded}，失败 ${fe}。成功的条目已可检索试搜。`,
                        duration: 6000
                    });
                    const detail = formatIngestErrorDetail(d.errors);
                    if (detail) {
                        await ElMessageBox.alert(detail, "失败详情", {
                            type: "warning",
                            confirmButtonText: "知道了",
                            customClass: "kb-ingest-err-dialog"
                        });
                    }
                } else {
                    let tip = formatIngestErrorDetail(d.errors);
                    if (!tip) {
                        tip =
                            "未返回具体错误行。请打开「任务中心」查看失败任务的完整错误信息，并检查后端 .env 中 EMBEDDING_API_BASE_URL、QDRANT_URL 及对应服务是否已启动。";
                    }
                    if (/ECONNREFUSED|connect\s+ECONNREFUSED/i.test(tip)) {
                        tip +=
                            "\n\n提示：后端无法连接 Embedding 服务时，常见原因是服务未监听 0.0.0.0 或防火墙未放行端口；可在运行后端的机器上执行 node backend/scripts/probe-embedding-fetch.cjs 自测。";
                    } else if (/Qdrant\s+url=/i.test(tip) || (/Qdrant/i.test(tip) && /ECONNREFUSED|fetch failed/i.test(tip))) {
                        tip += "\n\n提示：请确认本机 Qdrant 已启动且 QDRANT_URL 正确。";
                    }
                    await ElMessageBox.alert(tip.slice(0, 12000), "入库失败", {
                        type: "error",
                        confirmButtonText: "知道了",
                        customClass: "kb-ingest-err-dialog"
                    });
                }

                await load();
                clearSelected();
            }
        } catch (e) {
            clearPoll();
            uploadPhase.value = "idle";
            uploadProgress.value = 0;
            processProgress.value = 0;
            processHint.value = "";
            ElMessage.error(e?.response?.data?.msg || e?.message || "轮询失败");
        }
    };
    void tick();
    pollTimer.value = setInterval(() => void tick(), 2500);
};

const onUpload = async () => {
    const companyWide = isAdmin.value && uploadForm.value.deptScopeCompanyWide;
    if (
        !companyWide &&
        (!uploadForm.value.visibleDeptIds || uploadForm.value.visibleDeptIds.length === 0)
    ) {
        ElMessage.warning("请选择可检索部门，或由管理员勾选「全公司可见」");
        return;
    }
    if (
        !companyWide &&
        !uploadForm.value.categorySameAsVisible &&
        (!uploadForm.value.categoryDeptIds || uploadForm.value.categoryDeptIds.length === 0)
    ) {
        ElMessage.warning("请勾选「类属与可检索相同」，或单独选择文件类属部门");
        return;
    }
    if (!selectedFiles.value.length) {
        ElMessage.warning("请先选择要上传的文件/文件夹");
        return;
    }

    uploadPhase.value = "uploading";
    uploadProgress.value = 0;
    processProgress.value = 0;
    processHint.value = "";

    try {
        const formData = new FormData();
        if (companyWide) {
            formData.append("deptScopeCompanyWide", "1");
            formData.append("visibleDeptIds", JSON.stringify([]));
        } else {
            formData.append("visibleDeptIds", JSON.stringify(uploadForm.value.visibleDeptIds));
        }
        formData.append(
            "deptScopeIncludeChildren",
            uploadForm.value.deptScopeIncludeChildren ? "1" : "0"
        );
        formData.append(
            "categorySameAsVisible",
            uploadForm.value.categorySameAsVisible ? "1" : "0"
        );
        if (!uploadForm.value.categorySameAsVisible) {
            formData.append(
                "categoryDeptIds",
                JSON.stringify(uploadForm.value.categoryDeptIds || [])
            );
            formData.append(
                "categoryDeptScopeIncludeChildren",
                uploadForm.value.categoryDeptScopeIncludeChildren ? "1" : "0"
            );
        }
        const kg = uploadForm.value;
        if (kg.knowledgeType) formData.append("knowledgeType", kg.knowledgeType);
        if (kg.author) formData.append("author", kg.author);
        if (kg.docVersion) formData.append("docVersion", kg.docVersion);
        if (kg.sourceUri) formData.append("sourceUri", kg.sourceUri);
        if (kg.departmentCaption) formData.append("departmentCaption", kg.departmentCaption);
        selectedFiles.value.forEach((f) => formData.append("files", f, f.name));

        const res = await api.post("/documents/upload", formData, {
            timeout: 600000,
            onUploadProgress: (ev) => {
                const total = ev.total || 0;
                if (total > 0) {
                    uploadProgress.value = Math.min(100, Math.round((ev.loaded * 100) / total));
                }
            }
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "上传失败");

        const batchId = res.data?.data?.batchId;
        const enqueueErrors = Array.isArray(res.data?.data?.enqueueErrors)
            ? res.data.data.enqueueErrors
            : [];
        const totalJobs = Number(res.data?.data?.totalJobs) || 0;

        if (!batchId) throw new Error("未返回 batchId");
        if (enqueueErrors.length > 0) {
            ElMessage.warning(`已入队 ${totalJobs} 个；${enqueueErrors.length} 个在入队前失败`);
        }

        uploadProgress.value = 100;
        uploadPhase.value = "processing";
        processProgress.value = 0;
        pollBatchUntilDone(batchId);
    } catch (e) {
        uploadPhase.value = "idle";
        uploadProgress.value = 0;
        const d = e?.response?.data;
        const errs = Array.isArray(d?.data?.enqueueErrors) ? d.data.enqueueErrors : [];
        const errLines = errs
            .map((x) => (x?.fileName ? `${x.fileName}: ${x.msg || ""}` : x?.msg))
            .filter(Boolean)
            .slice(0, 3);
        const parts = [d?.msg, errLines.length ? errLines.join("；") : ""].filter(Boolean);
        ElMessage.error(parts.join(" — ") || e?.message || "上传失败");
    }
};

const onDelete = async (row) => {
    try {
        await ElMessageBox.confirm(`确认删除「${row.title}」？将清理向量并标记删除。`, "删除文档", {
            type: "warning"
        });
    } catch {
        return;
    }

    try {
        const res = await api.delete(`/documents/${row.id}`);
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "删除失败");
        ElMessage.success("已删除");
        await load();
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "删除失败");
    }
};

const onReindex = async (row) => {
    if (!row?.id) return;
    const title = row.title || row.id;
    try {
        await ElMessageBox.confirm(
            `确定重新入库「${title}」？将清空已索引校验并排队异步处理。`,
            "重新入库",
            { type: "warning", confirmButtonText: "确定", cancelButtonText: "取消" }
        );
    } catch {
        return;
    }
    try {
        const res = await api.post(`/documents/${row.id}/reindex`);
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "排队失败");
        ElMessage.success(res.data?.msg || "已排队");
        await load();
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "重新入库失败");
    }
};

watch(
    () => uploadForm.value.categorySameAsVisible,
    async (same) => {
        if (same) {
            uploadForm.value.categoryDeptIds = [...uploadForm.value.visibleDeptIds];
            await nextTick();
            deptCategoryTreeRef.value?.setCheckedKeys(uploadForm.value.categoryDeptIds);
        }
    }
);

onMounted(async () => {
    await loadDepts();
    await load();
});

onUnmounted(() => {
    clearPoll();
});
</script>

<style scoped>
.upload-two-col {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 20px 24px;
    margin-bottom: 8px;
}

.upload-col {
    min-width: 0;
}

.upload-col-dept {
    flex: 1 1 320px;
    max-width: 100%;
}

.upload-col-files {
    flex: 1 1 360px;
    max-width: 100%;
}

.dept-scope-section {
    margin-bottom: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    max-width: none;
}

.dept-scope-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px 12px;
    margin-bottom: 6px;
}

.dept-scope-title {
    font-weight: 600;
    font-size: 14px;
    color: #262626;
}

.dept-scope-meta {
    font-size: 12px;
    color: #8c8c8c;
}

.dept-scope-hint {
    margin: 0 0 10px;
    font-size: 12px;
    color: #595959;
    line-height: 1.5;
}

.dept-cat-divider {
    margin: 14px 0 8px;
}

.dept-cat-head {
    margin-top: 8px;
}

.dept-tree-panel--compact {
    max-height: 240px;
}

.dept-tree-panel {
    flex: 1;
    min-height: 200px;
    max-height: 320px;
    overflow: auto;
    padding: 10px 8px 10px 4px;
    border: 1px solid #e8e8e8;
    border-radius: 8px;
    background: #fafafa;
}

.dept-tree-empty {
    padding: 24px 12px;
    text-align: center;
    font-size: 13px;
    color: #8c8c8c;
}

.dept-tree :deep(.el-tree-node__content) {
    border-radius: 6px;
    height: 32px;
}

.dept-tree :deep(.el-tree-node__content:hover) {
    background: rgba(24, 144, 255, 0.08);
}

.dept-tree :deep(.el-tree-node.is-current > .el-tree-node__content) {
    background: rgba(24, 144, 255, 0.12);
}

.dept-tree-node {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
}

.dept-tree-folder {
    font-size: 16px;
    color: #1677ff;
    flex-shrink: 0;
}

.dept-tree-label {
    color: #262626;
}

.dept-scope-actions {
    margin-top: 8px;
}

.dept-include-row {
    margin-top: 10px;
    font-size: 13px;
    color: var(--kb-text-secondary, #595959);
}

.empty {
    padding: 20px 0;
    text-align: center;
    color: var(--kb-text-secondary, #666);
    font-size: 14px;
}

.upload-box {
    margin-top: 0;
    height: 100%;
    min-height: 200px;
    box-sizing: border-box;
    padding: 16px 16px 14px;
    border: 1px dashed #adc6ff;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(24, 144, 255, 0.06) 0%, rgba(255, 255, 255, 0.5) 100%);
    display: flex;
    flex-direction: column;
}

.upload-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.upload-hint {
    color: #8c8c8c;
    font-size: 12px;
}

.selected-meta {
    margin-top: 8px;
    color: #595959;
    font-size: 13px;
}

.selected-list {
    margin-top: 8px;
    max-height: 120px;
    overflow: auto;
    padding-right: 6px;
}

.selected-item {
    font-size: 12px;
    color: #262626;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
}

.selected-item.muted {
    color: #8c8c8c;
}

.kg-upload-collapse {
    margin-top: 12px;
    border: none;
    --el-collapse-header-bg-color: transparent;
}
.kg-upload-collapse :deep(.el-collapse-item__header) {
    font-size: 13px;
    font-weight: 500;
    color: #0958d9;
}
.kg-upload-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 12px;
}
@media (max-width: 720px) {
    .kg-upload-grid {
        grid-template-columns: 1fr;
    }
}
.kg-field-wide {
    grid-column: 1 / -1;
}
.kg-upload-hint {
    margin: 10px 0 0;
    font-size: 12px;
    color: #8c8c8c;
    line-height: 1.5;
}
.kg-upload-hint code {
    font-size: 11px;
    padding: 0 4px;
    background: #f5f5f5;
    border-radius: 3px;
}

.upload-submit {
    margin-top: 14px;
    display: flex;
    gap: 12px;
    align-items: center;
}

.type-badge {
    display: inline-block;
    min-width: 2.5em;
    padding: 2px 8px;
    font-size: 12px;
    font-weight: 600;
    color: #0958d9;
    background: #e6f4ff;
    border-radius: 4px;
    cursor: default;
}

.size-cell {
    font-variant-numeric: tabular-nums;
    color: #262626;
}

.path-cell-wrap {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    max-width: 100%;
}

.path-cell {
    font-size: 12px;
    line-height: 1.45;
    color: #262626;
    word-break: break-all;
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.path-cell--muted {
    color: #8c8c8c;
}

.path-cell--copy {
    cursor: copy;
    user-select: text;
}

.doc-dash {
    color: #8c8c8c;
}

.index-meta-cell {
    font-size: 12px;
    color: #262626;
    cursor: default;
}

.hidden-input {
    display: none;
}

.progress-block {
    margin-bottom: 12px;
}

.progress-row {
    margin-bottom: 10px;
}

.progress-label {
    font-size: 13px;
    color: #595959;
    margin-bottom: 6px;
}

.progress-hint {
    margin-top: 6px;
    font-size: 12px;
    color: #8c8c8c;
}
</style>

