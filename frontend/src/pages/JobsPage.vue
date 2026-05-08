<template>
    <div class="kb-page">
        <el-card class="kb-card" v-loading="loading">
            <p class="kb-hint">
                序号为当前页连续编号；任务与文档 ID 为全局唯一 UUID（不会从 1 递增），下列表中完整展示，可复制使用。
                「文件绝对路径」由服务端根据 <code>storage_key</code> 与
                <code>KB_STORAGE_ROOT</code> / 镜像目录解析；镜像源文件以实际同步目录为准。
            </p>

            <el-table :data="items" class="kb-table" stripe border style="width: 100%">
                <el-table-column
                    type="index"
                    label="序号"
                    width="68"
                    align="center"
                    :index="rowIndex"
                />
                <el-table-column label="创建时间" min-width="168">
                    <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
                </el-table-column>
                <el-table-column label="结束时间" min-width="168">
                    <template #default="{ row }">{{ formatDateTime(row.finishedAt) }}</template>
                </el-table-column>
                <el-table-column label="任务ID" min-width="300">
                    <template #default="{ row }">
                        <span v-if="row.id" class="kb-mono uuid-full">{{ row.id }}</span>
                        <span v-else>—</span>
                    </template>
                </el-table-column>
                <el-table-column label="文档ID" min-width="300">
                    <template #default="{ row }">
                        <span v-if="row.documentId" class="kb-mono uuid-full">{{ row.documentId }}</span>
                        <span v-else>—</span>
                    </template>
                </el-table-column>
                <el-table-column label="文档标题" min-width="140" show-overflow-tooltip>
                    <template #default="{ row }">
                        {{ row.documentTitle || "—" }}
                    </template>
                </el-table-column>
                <el-table-column label="文件绝对路径" min-width="280" show-overflow-tooltip>
                    <template #header>
                        <span title="双击下方路径文本可复制">文件绝对路径</span>
                    </template>
                    <template #default="{ row }">
                        <div v-if="row.absolutePath" class="path-wrap">
                            <span
                                class="path-text path-text--copy"
                                title="双击复制完整路径"
                                @dblclick="copyText(row.absolutePath)"
                                >{{ row.absolutePath }}</span
                            >
                        </div>
                        <span
                            v-else-if="row.storageKey"
                            class="path-text path-muted path-text--copy"
                            title="双击复制 storage_key"
                            @dblclick="copyText(row.storageKey)"
                            >{{ row.storageKey }}</span
                        >
                        <span v-else>—</span>
                    </template>
                </el-table-column>
                <el-table-column label="任务类型" min-width="112">
                    <template #default="{ row }">{{ formatJobType(row.jobType) }}</template>
                </el-table-column>
                <el-table-column label="状态" width="100" align="center">
                    <template #default="{ row }">
                        <el-tag :type="statusTagType(row.status)" size="small" effect="light">
                            {{ formatJobStatus(row.status) }}
                        </el-tag>
                    </template>
                </el-table-column>
                <el-table-column label="尝试次数" width="100" align="center">
                    <template #default="{ row }">
                        {{ row.attemptCount ?? 0 }} / {{ row.maxAttempts ?? "—" }}
                    </template>
                </el-table-column>
                <el-table-column
                    prop="errorCode"
                    label="错误码"
                    width="100"
                    show-overflow-tooltip
                />
                <el-table-column
                    prop="errorMessage"
                    label="错误信息"
                    min-width="240"
                    show-overflow-tooltip
                />
            </el-table>

            <el-pagination
                v-model:current-page="page"
                v-model:page-size="pageSize"
                :total="total"
                layout="total, prev, pager, next, sizes"
                :page-sizes="[10, 20, 50]"
                class="kb-pager"
                @current-change="load"
                @size-change="load"
            />

            <div v-if="!loading && items.length === 0" class="empty">暂无任务</div>
        </el-card>
    </div>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/datetimeFormat";
import { formatJobType, formatJobStatus } from "../lib/displayFormat";
import { ElMessage } from "element-plus";

const items = ref([]);
const loading = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);

const rowIndex = (i) => (page.value - 1) * pageSize.value + i + 1;

const copyText = async (text) => {
    const t = String(text || "").trim();
    if (!t) {
        ElMessage.warning("无可复制路径");
        return;
    }
    try {
        await navigator.clipboard.writeText(t);
        ElMessage.success("已复制路径");
    } catch {
        ElMessage.error("复制失败");
    }
};

const statusTagType = (s) => {
    if (s === "success") return "success";
    if (s === "failed") return "danger";
    if (s === "running") return "warning";
    if (s === "queued") return "info";
    return "";
};

const load = async () => {
    loading.value = true;
    try {
        const res = await api.get("/index-jobs", {
            params: { page: page.value, pageSize: pageSize.value }
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        items.value = res.data?.data?.items || [];
        total.value = res.data?.data?.total ?? 0;
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载失败");
        items.value = [];
    } finally {
        loading.value = false;
    }
};

onMounted(load);
</script>

<style scoped>
.empty {
    padding: 20px 0;
    text-align: center;
    color: var(--kb-text-secondary, #666);
    font-size: 14px;
}

.kb-hint {
    margin: 0 0 16px;
    padding: 10px 14px;
    font-size: 13px;
    line-height: 1.55;
    color: #595959;
    background: #f6ffed;
    border: 1px solid #b7eb8f;
    border-radius: 8px;
}

.uuid-full {
    display: inline-block;
    max-width: 100%;
    line-height: 1.45;
    font-size: 12px;
    color: #096dd9;
    word-break: break-all;
    white-space: normal;
}

.path-wrap {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    max-width: 100%;
}

.path-text {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    line-height: 1.45;
    word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #262626;
}

.path-text--copy {
    cursor: copy;
    user-select: text;
}

.path-muted {
    color: #8c8c8c;
}
</style>
