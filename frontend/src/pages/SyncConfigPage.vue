<template>
    <div class="page">
        <el-card v-loading="loading">
            <template #header>
                <div class="card-head">
                    <span>同步配置</span>
                    <el-button text type="primary" @click="onRefreshAll">刷新</el-button>
                </div>
            </template>

            <el-alert type="info" show-icon :closable="false" class="mb">
                将 <strong>AnyShare等客户端已自动落地到本地的目录</strong>作为镜像根，由本页配置路径后，后端会<strong>直接扫描该目录</strong>并写入知识库（<strong>不再经过中转文件夹复制</strong>）。
                支持扩展名（<strong>.md / .txt / .docx / .xlsx</strong>）。<strong>镜像后台轮询</strong>与<strong>自动同步（定时）</strong>是两套机制：轮询按固定间隔小批量扫目录；定时按 cron 在指定时刻做整轮扫描（可「当天已成功则跳过」）。若只需每天同步一次，可<strong>关闭轮询</strong>仅保留定时或「立即同步」。
                环境变量 <code>KB_SYNC_MIRROR_DIR</code> 在未填「目标目录」时作为后备；<code>DISABLE_MIRROR_SCAN=1</code> 可强制关闭轮询（优先级高于本页开关）。
                同步历史表请执行 <code>backend/sql/013_kb_folder_sync_runs.sql</code>；轮询相关列请执行 <code>backend/sql/014_kb_sync_mirror_poll.sql</code>。
            </el-alert>

            <el-form label-width="140px" style="max-width: 720px">
                <el-form-item label="目标目录">
                    <el-input
                        v-model="form.stagingPath"
                        placeholder="例：E:\AnyShareSync\品质中心\文档库（本地已下载目录）"
                    />
                </el-form-item>
                <el-form-item label="进程检测">
                    <el-input
                        v-model="form.processNames"
                        placeholder="任务管理器「名称」列，如 AnyShare.exe（逗号分隔；勿填 PID）"
                    />
                    <div class="form-actions">
                        <el-button size="small" :loading="procChecking" @click="checkProcess">检测当前是否命中</el-button>
                    </div>
                    <p v-if="procCheckResult" class="muted small pre-wrap">{{ procCheckResult }}</p>
                </el-form-item>
                <el-form-item label="企业微信 Webhook">
                    <el-input
                        v-model="form.wecomWebhookUrl"
                        type="password"
                        show-password
                        placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
                    />
                    <div class="form-actions">
                        <el-button size="small" :loading="wecomTesting" @click="testWecom">发送测试消息</el-button>
                    </div>
                    <p v-if="wecomTestResult" class="muted small pre-wrap">{{ wecomTestResult }}</p>
                </el-form-item>
                <el-form-item label="自动同步">
                    <el-switch v-model="form.autoSyncEnabled" />
                </el-form-item>
                <el-form-item label="镜像后台轮询">
                    <el-switch v-model="form.mirrorPollEnabled" />
                    <span class="muted small">
                        开启后按下方间隔持续小批量扫描目标目录（与定时全量互补；不需要可关闭，避免清库后文件仍在盘里时自动又长回数据）
                    </span>
                </el-form-item>
                <el-form-item label="轮询间隔">
                    <el-input-number
                        v-model="form.mirrorPollIntervalSec"
                        :min="10"
                        :max="3600"
                        :step="10"
                        controls-position="right"
                    />
                    <span class="muted small">秒（10～3600）。保存后立即生效。</span>
                </el-form-item>
                <el-form-item label="每轮最多文件数">
                    <el-input-number
                        v-model="form.mirrorPollMaxFiles"
                        :min="1"
                        :max="500"
                        :step="10"
                        controls-position="right"
                    />
                    <span class="muted small">单次轮询最多处理多少个文件（减轻瞬时压力）</span>
                </el-form-item>
                <el-form-item label="定时执行 1">
                    <el-time-picker
                        v-model="scheduleTime1"
                        format="HH:mm"
                        value-format="HH:mm"
                        placeholder="不选表示关闭本档"
                        clearable
                        arrow-control
                        class="time-pick"
                    />
                    <el-button size="small" class="sched-close" :loading="saving" @click="closeScheduleSlot(1)">
                        关闭定时1
                    </el-button>
                    <span class="muted small">每天该时刻触发一次；清空或点关闭即停用（与服务器时区或 KB_CRON_TZ 一致）</span>
                </el-form-item>
                <el-form-item label="定时执行 2">
                    <el-time-picker
                        v-model="scheduleTime2"
                        format="HH:mm"
                        value-format="HH:mm"
                        placeholder="可选第二档"
                        clearable
                        arrow-control
                        class="time-pick"
                    />
                    <el-button size="small" class="sched-close" :loading="saving" @click="closeScheduleSlot(2)">
                        关闭定时2
                    </el-button>
                    <span class="muted small">可选第二档；关闭后仅保留定时1（若定时1仍启用）</span>
                </el-form-item>
                <el-form-item label="当天已成功则跳过">
                    <el-switch v-model="form.skipIfSyncedToday" />
                    <span class="muted small">仅影响<strong>自动</strong>定时；手动「立即同步」始终执行。</span>
                </el-form-item>
                <el-form-item>
                    <el-button type="primary" :loading="saving" @click="save">保存配置</el-button>
                    <el-button type="success" :loading="running" @click="runSync">立即同步</el-button>
                </el-form-item>
            </el-form>

            <el-descriptions v-if="status.lastRunAt || status.lastSuccessDate" :column="1" border class="mt">
                <el-descriptions-item label="上次运行时间">{{
                    formatDateTime(status.lastRunAt) || "—"
                }}</el-descriptions-item>
                <el-descriptions-item label="上次状态">{{ status.lastRunStatus || "—" }}</el-descriptions-item>
                <el-descriptions-item label="上次摘要">{{ status.lastRunMessage || "—" }}</el-descriptions-item>
                <el-descriptions-item label="最近成功日">{{ status.lastSuccessDate || "—" }}</el-descriptions-item>
                <el-descriptions-item label="最近成功时间">{{
                    formatDateTime(status.lastSuccessAt) || "—"
                }}</el-descriptions-item>
            </el-descriptions>

            <p v-if="runResult" class="muted small pre-wrap">{{ runResult }}</p>
        </el-card>

        <el-card class="mt history-card" v-loading="runsLoading">
            <template #header>
                <span>同步历史</span>
            </template>
            <el-table
                :data="runItems"
                stripe
                border
                size="small"
                class="history-table"
                table-layout="fixed"
                style="width: 100%"
            >
                <el-table-column label="结束时间" width="168" header-align="center" align="center">
                    <template #default="{ row }">{{ formatDateTime(row.finishedAt) || "—" }}</template>
                </el-table-column>
                <el-table-column label="触发" width="76" header-align="center" align="center">
                    <template #default="{ row }">{{ formatTrigger(row.triggerType) }}</template>
                </el-table-column>
                <el-table-column label="状态" width="108" header-align="center" align="center">
                    <template #default="{ row }">
                        <el-tag size="small" effect="light" :type="runStatusTag(row.status)">{{
                            formatRunStatus(row.status)
                        }}</el-tag>
                    </template>
                </el-table-column>
                <el-table-column label="耗时(ms)" width="102" header-align="center" align="right">
                    <template #default="{ row }">{{ row.durationMs ?? "—" }}</template>
                </el-table-column>
                <el-table-column label="扫描文件" width="96" header-align="center" align="right">
                    <template #default="{ row }">{{ row.filesOnShare ?? "—" }}</template>
                </el-table-column>
                <el-table-column label="入库触发" width="88" header-align="center" align="right">
                    <template #default="{ row }">{{ row.copied ?? "—" }}</template>
                </el-table-column>
                <el-table-column label="未变化" width="88" header-align="center" align="right">
                    <template #default="{ row }">{{ row.skippedMd5 ?? "—" }}</template>
                </el-table-column>
                <el-table-column label="文件错误" width="88" header-align="center" align="right">
                    <template #default="{ row }">{{ row.fileErrors ?? "—" }}</template>
                </el-table-column>
                <el-table-column prop="summary" label="摘要" min-width="200" show-overflow-tooltip />
            </el-table>
            <el-pagination
                v-model:current-page="runPage"
                :page-size="runPageSize"
                :total="runTotal"
                layout="total, prev, pager, next"
                class="run-pager"
                @current-change="loadRuns"
            />
        </el-card>
    </div>
</template>

<script setup>
import { onMounted, reactive, ref } from "vue";
import { api } from "../lib/api";
import { ElMessage } from "element-plus";
import { cronDailyToHHmm, hhmmToCronDaily } from "../lib/syncScheduleTime";
import { formatDateTime } from "../lib/datetimeFormat";

const loading = ref(false);
const saving = ref(false);
const running = ref(false);
const runResult = ref("");
const procChecking = ref(false);
const procCheckResult = ref("");
const wecomTesting = ref(false);
const wecomTestResult = ref("");

const form = reactive({
    stagingPath: "",
    processNames: "AnyShare.exe",
    wecomWebhookUrl: "",
    autoSyncEnabled: false,
    skipIfSyncedToday: true,
    mirrorPollEnabled: true,
    mirrorPollIntervalSec: 60,
    mirrorPollMaxFiles: 80
});

const status = reactive({
    lastRunAt: "",
    lastRunStatus: "",
    lastRunMessage: "",
    lastSuccessDate: "",
    lastSuccessAt: ""
});

const scheduleTime1 = ref("");
const scheduleTime2 = ref("");

const runsLoading = ref(false);
const runItems = ref([]);
const runPage = ref(1);
const runPageSize = 20;
const runTotal = ref(0);

const formatTrigger = (t) => (t === "cron" ? "定时" : t === "manual" ? "手动" : t || "—");

const formatRunStatus = (s) => {
    if (s === "success") return "成功";
    if (s === "success_with_errors") return "成功(有错)";
    if (s === "error") return "失败";
    return s || "—";
};

const runStatusTag = (s) => {
    if (s === "success") return "success";
    if (s === "success_with_errors") return "warning";
    if (s === "error") return "danger";
    return "info";
};

const applySettingsToForm = (data) => {
    form.stagingPath = data.stagingPath || "";
    form.processNames = data.processNames || "";
    form.wecomWebhookUrl = data.wecomWebhookUrl || "";
    form.autoSyncEnabled = Boolean(data.autoSyncEnabled);
    form.skipIfSyncedToday = data.skipIfSyncedToday !== false;
    form.mirrorPollEnabled = data.mirrorPollEnabled !== false;
    const ms = Number(data.mirrorPollIntervalMs);
    form.mirrorPollIntervalSec = Number.isFinite(ms) && ms >= 10_000 ? Math.round(ms / 1000) : 60;
    const cap = Number(data.mirrorPollMaxFiles);
    form.mirrorPollMaxFiles = Number.isFinite(cap) && cap > 0 ? cap : 80;
    status.lastRunAt = data.lastRunAt || "";
    status.lastRunStatus = data.lastRunStatus || "";
    status.lastRunMessage = data.lastRunMessage || "";
    status.lastSuccessDate = data.lastSuccessDate || "";
    status.lastSuccessAt = data.lastSuccessAt || "";
    scheduleTime1.value = cronDailyToHHmm(data.cronExpr1) || "";
    const t2 = cronDailyToHHmm(data.cronExpr2);
    scheduleTime2.value = t2 || "";
};

const loadSettings = async () => {
    loading.value = true;
    try {
        const res = await api.get("/admin/sync-settings");
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        applySettingsToForm(res.data.data || {});
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载失败");
    } finally {
        loading.value = false;
    }
};

const loadRuns = async () => {
    runsLoading.value = true;
    try {
        const res = await api.get("/admin/sync-runs", {
            params: { page: runPage.value, pageSize: runPageSize }
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载历史失败");
        const d = res.data.data || {};
        runItems.value = d.items || [];
        runTotal.value = d.total ?? 0;
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载历史失败");
    } finally {
        runsLoading.value = false;
    }
};

const onRefreshAll = async () => {
    await loadSettings();
    await loadRuns();
};

const buildCronPayload = () => {
    let e1 = "";
    if (scheduleTime1.value) {
        e1 = hhmmToCronDaily(scheduleTime1.value);
        if (!e1) {
            return { error: "定时 1 时刻无效" };
        }
    }
    let e2 = "";
    if (scheduleTime2.value) {
        e2 = hhmmToCronDaily(scheduleTime2.value);
        if (!e2) {
            return { error: "定时 2 时刻无效" };
        }
    }
    if (form.autoSyncEnabled && !e1 && !e2) {
        return { error: "已开启自动同步，请至少保留一档定时，或先关闭「自动同步」" };
    }
    return { cronExpr1: e1, cronExpr2: e2 };
};

const save = async () => {
    const built = buildCronPayload();
    if (built.error) {
        ElMessage.warning(built.error);
        return;
    }
    saving.value = true;
    try {
        const res = await api.put("/admin/sync-settings", {
            sharePath: "",
            stagingPath: form.stagingPath,
            processNames: form.processNames,
            wecomWebhookUrl: form.wecomWebhookUrl,
            autoSyncEnabled: form.autoSyncEnabled,
            skipIfSyncedToday: form.skipIfSyncedToday,
            mirrorPollEnabled: form.mirrorPollEnabled,
            mirrorPollIntervalMs: Math.max(10_000, Math.min(3_600_000, form.mirrorPollIntervalSec * 1000)),
            mirrorPollMaxFiles: form.mirrorPollMaxFiles,
            cronExpr1: built.cronExpr1,
            cronExpr2: built.cronExpr2
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "保存失败");
        applySettingsToForm(res.data.data || {});
        ElMessage.success("已保存");
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "保存失败");
    } finally {
        saving.value = false;
    }
};

/** 一键关闭某一档定时并立即保存（保留另一档与其它配置） */
const closeScheduleSlot = async (slot) => {
    if (slot === 1) scheduleTime1.value = "";
    else scheduleTime2.value = "";

    const built = buildCronPayload();
    if (built.error) {
        ElMessage.warning(built.error);
        await loadSettings();
        return;
    }
    saving.value = true;
    try {
        const res = await api.put("/admin/sync-settings", {
            sharePath: "",
            stagingPath: form.stagingPath,
            processNames: form.processNames,
            wecomWebhookUrl: form.wecomWebhookUrl,
            autoSyncEnabled: form.autoSyncEnabled,
            skipIfSyncedToday: form.skipIfSyncedToday,
            mirrorPollEnabled: form.mirrorPollEnabled,
            mirrorPollIntervalMs: Math.max(10_000, Math.min(3_600_000, form.mirrorPollIntervalSec * 1000)),
            mirrorPollMaxFiles: form.mirrorPollMaxFiles,
            cronExpr1: built.cronExpr1,
            cronExpr2: built.cronExpr2
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "保存失败");
        applySettingsToForm(res.data.data || {});
        ElMessage.success(slot === 1 ? "已关闭定时1" : "已关闭定时2");
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "保存失败");
        await loadSettings();
    } finally {
        saving.value = false;
    }
};

const checkProcess = async () => {
    procChecking.value = true;
    procCheckResult.value = "";
    try {
        const res = await api.get("/admin/sync-settings/process-check");
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "检测失败");
        const d = res.data.data || {};
        const lines = (d.lines || []).map((x) => `${x.token}: ${x.running ? "运行中" : "未运行"}`).join("\n");
        procCheckResult.value = `任一命中即通过（定时跳过逻辑依赖此项）。\n${lines || JSON.stringify(d, null, 2)}`;
    } catch (e) {
        procCheckResult.value = e?.response?.data?.msg || e?.message || "检测失败";
    } finally {
        procChecking.value = false;
    }
};

const testWecom = async () => {
    wecomTesting.value = true;
    wecomTestResult.value = "";
    try {
        const res = await api.post("/admin/sync-settings/test-wecom");
        wecomTestResult.value = res.data?.msg || (res.data?.code === 200 ? "ok" : "失败");
        if (res.data?.code === 200) ElMessage.success("已发送");
        else ElMessage.warning(wecomTestResult.value);
    } catch (e) {
        wecomTestResult.value = e?.response?.data?.msg || e?.message || "失败";
        ElMessage.error(wecomTestResult.value);
    } finally {
        wecomTesting.value = false;
    }
};

const runSync = async () => {
    running.value = true;
    runResult.value = "";
    try {
        const res = await api.post("/admin/sync-settings/run", { force: true }, { timeout: 600000 });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "执行失败");
        const d = res.data.data || {};
        runResult.value = d.summary || d.msg || JSON.stringify(d);
        ElMessage.success(d.skipped ? "已跳过" : "已完成");
        await loadSettings();
        await loadRuns();
    } catch (e) {
        runResult.value = e?.response?.data?.msg || e?.message || "执行失败";
        ElMessage.error(runResult.value);
    } finally {
        running.value = false;
    }
};

onMounted(() => {
    void onRefreshAll();
});
</script>

<style scoped>
.page {
    padding: 16px;
}
.mb {
    margin-bottom: 16px;
}
.mt {
    margin-top: 16px;
}
.muted {
    color: var(--el-text-color-secondary);
}
.small {
    font-size: 12px;
}
.pre-wrap {
    white-space: pre-wrap;
}
.form-actions {
    margin-top: 8px;
}
.time-pick {
    width: 140px;
    margin-right: 8px;
}
.sched-close {
    margin-left: 8px;
    vertical-align: middle;
}
.card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.history-card {
    margin-top: 16px;
}
.run-pager {
    margin-top: 12px;
    justify-content: flex-end;
}
</style>
