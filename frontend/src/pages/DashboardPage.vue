<template>
    <div class="page">
        <el-card v-loading="loading" shadow="hover" class="dash-card">
            <div class="dash-toolbar">
                <el-button v-if="!loading" text type="primary" @click="load">刷新</el-button>
            </div>

            <el-alert
                v-if="errorMsg"
                type="error"
                :title="errorMsg"
                show-icon
                :closable="false"
                class="mb"
            />
            <el-alert
                v-else-if="data && !data.qdrantOk"
                type="warning"
                title="Qdrant 统计暂不可用"
                :description="data.qdrantMessage || '请检查 QDRANT_URL 与向量服务'"
                show-icon
                :closable="false"
                class="mb"
            />

            <template v-if="data">
                <el-row :gutter="16" class="kpi-row">
                    <el-col :xs="24" :sm="12" :md="6">
                        <div class="kpi-tile">
                            <div class="kpi-label">向量点数量</div>
                            <div class="kpi-val">{{ vectorDisplay }}</div>
                        </div>
                    </el-col>
                    <el-col :xs="24" :sm="12" :md="6">
                        <div class="kpi-tile">
                            <div class="kpi-label">文档条数（合计）</div>
                            <div class="kpi-val kpi-val--dark">{{ docTotal }}</div>
                        </div>
                    </el-col>
                    <el-col :xs="24" :sm="12" :md="6">
                        <div class="kpi-tile">
                            <div class="kpi-label">24h 任务成功 / 失败</div>
                            <div class="kpi-val sm">
                                <span class="ok">{{ Number(jobs24h.successCount) || 0 }}</span>
                                <span class="sep">/</span>
                                <span class="bad">{{ Number(jobs24h.failedCount) || 0 }}</span>
                            </div>
                        </div>
                    </el-col>
                    <el-col :xs="24" :sm="12" :md="6">
                        <div class="kpi-tile">
                            <div class="kpi-label">队列中任务</div>
                            <div class="kpi-val kpi-val--accent">{{ Number(jobs24h.pendingCount) || 0 }}</div>
                        </div>
                    </el-col>
                </el-row>

                <el-row :gutter="16" class="chart-row">
                    <el-col :xs="24" :lg="12">
                        <div class="chart-panel">
                            <div class="chart-title">文档状态分布</div>
                            <div ref="chartDocRef" class="chart-dom" />
                        </div>
                    </el-col>
                    <el-col :xs="24" :lg="12">
                        <div class="chart-panel">
                            <div class="chart-title">索引任务状态</div>
                            <div ref="chartJobRef" class="chart-dom" />
                        </div>
                    </el-col>
                </el-row>

                <el-row :gutter="16" class="chart-row">
                    <el-col :span="24">
                        <div class="chart-panel wide">
                            <div class="chart-title">近 14 日操作量（审计）</div>
                            <div ref="chartAuditRef" class="chart-dom chart-dom-tall" />
                        </div>
                    </el-col>
                </el-row>
            </template>
            <div v-else-if="!loading && !errorMsg" class="empty">暂无数据</div>
        </el-card>
    </div>
</template>

<script setup>
import * as echarts from "echarts";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { api } from "../lib/api";

const loading = ref(true);
const errorMsg = ref("");
const data = ref(null);

const chartDocRef = ref(null);
const chartJobRef = ref(null);
const chartAuditRef = ref(null);
/** @type {import("echarts").EChartsType | null} */
let instDoc = null;
/** @type {import("echarts").EChartsType | null} */
let instJob = null;
/** @type {import("echarts").EChartsType | null} */
let instAudit = null;

const jobs24h = computed(() => (data.value && data.value.jobs24hSummary) || {});

const docTotal = computed(() => {
    const rows = data.value?.documentsByStatus;
    if (!Array.isArray(rows)) return 0;
    return rows.reduce((s, r) => s + (Number(r.cnt) || 0), 0);
});

const vectorDisplay = computed(() => {
    const v = data.value?.vectorPoints;
    if (v == null) return "—";
    return v;
});

const palette = ["#1890ff", "#40a9ff", "#69c0ff", "#597ef7", "#36cfc9", "#faad14", "#722ed1", "#ff7a45"];

function disposeAll() {
    instDoc?.dispose();
    instJob?.dispose();
    instAudit?.dispose();
    instDoc = null;
    instJob = null;
    instAudit = null;
}

function resizeAll() {
    instDoc?.resize();
    instJob?.resize();
    instAudit?.resize();
}

function renderCharts() {
    const d = data.value;
    if (!d) return;

    const docRows = Array.isArray(d.documentsByStatus) ? d.documentsByStatus : [];
    const jobRows = Array.isArray(d.indexJobsByStatus) ? d.indexJobsByStatus : [];
    const auditRows = Array.isArray(d.auditDaily) ? d.auditDaily : [];

    if (chartDocRef.value) {
        if (!instDoc) instDoc = echarts.init(chartDocRef.value);
        instDoc.setOption({
            tooltip: { trigger: "item" },
            legend: { bottom: 0, left: "center" },
            color: palette,
            series: [
                {
                    type: "pie",
                    radius: ["40%", "68%"],
                    center: ["50%", "46%"],
                    itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
                    label: { formatter: "{b}\n{c}" },
                    data: docRows.map((r) => ({ name: String(r.status ?? ""), value: Number(r.cnt) || 0 }))
                }
            ]
        });
    }

    if (chartJobRef.value) {
        if (!instJob) instJob = echarts.init(chartJobRef.value);
        instJob.setOption({
            tooltip: { trigger: "axis" },
            grid: { left: 48, right: 16, top: 24, bottom: 40 },
            color: palette,
            xAxis: {
                type: "category",
                data: jobRows.map((r) => String(r.status ?? "")),
                axisLabel: { rotate: jobRows.length > 6 ? 30 : 0 }
            },
            yAxis: { type: "value", minInterval: 1 },
            series: [
                {
                    type: "bar",
                    barMaxWidth: 48,
                    data: jobRows.map((r) => Number(r.cnt) || 0),
                    itemStyle: { borderRadius: [4, 4, 0, 0] }
                }
            ]
        });
    }

    if (chartAuditRef.value) {
        if (!instAudit) instAudit = echarts.init(chartAuditRef.value);
        const days = auditRows.map((x) => String(x.day ?? ""));
        const counts = auditRows.map((x) => Number(x.cnt) || 0);
        instAudit.setOption({
            tooltip: { trigger: "axis" },
            grid: { left: 48, right: 24, top: 32, bottom: 32 },
            color: ["#1890ff"],
            xAxis: { type: "category", boundaryGap: false, data: days },
            yAxis: { type: "value", minInterval: 1 },
            series: [
                {
                    type: "line",
                    smooth: true,
                    symbol: "circle",
                    symbolSize: 8,
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: "rgba(24,144,255,0.35)" },
                            { offset: 1, color: "rgba(24,144,255,0.02)" }
                        ])
                    },
                    lineStyle: { width: 3, color: "#1890ff" },
                    itemStyle: { color: "#1890ff" },
                    data: counts
                }
            ]
        });
    }
}

const load = async () => {
    loading.value = true;
    errorMsg.value = "";
    try {
        const res = await api.get("/admin/dashboard");
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        data.value = res.data?.data || null;
    } catch (e) {
        errorMsg.value = e?.message || "看板接口失败";
        data.value = null;
    } finally {
        loading.value = false;
    }
};

watch(
    () => data.value,
    async () => {
        await nextTick();
        renderCharts();
        resizeAll();
    }
);

onMounted(async () => {
    await load();
    await nextTick();
    renderCharts();
    window.addEventListener("resize", resizeAll);
});

onUnmounted(() => {
    window.removeEventListener("resize", resizeAll);
    disposeAll();
});
</script>

<style scoped>
.page {
    padding: 16px;
}
.dash-card {
    border-radius: 8px;
    border: 1px solid var(--kb-border, #e8e8e8);
    box-shadow: var(--kb-shadow-card, 0 1px 4px rgba(0, 0, 0, 0.06));
}
.dash-toolbar {
    display: flex;
    justify-content: flex-end;
    margin: 0 0 12px;
}
.mb {
    margin-bottom: 16px;
}
.kpi-row {
    margin-bottom: 8px;
}
.kpi-tile {
    background: var(--kb-bg-card, #fff);
    border: 1px solid var(--kb-border, #e8e8e8);
    border-radius: 8px;
    padding: 16px 18px;
    margin-bottom: 12px;
    box-shadow: var(--kb-shadow-card, 0 1px 4px rgba(0, 0, 0, 0.06));
}
.kpi-label {
    font-size: 12px;
    color: #888;
    margin-bottom: 6px;
}
.kpi-val {
    font-size: 24px;
    font-weight: 700;
    color: #1890ff;
}
.kpi-val.sm {
    font-size: 20px;
}
.kpi-val .ok {
    color: #00a870;
}
.kpi-val .bad {
    color: #ff4d4f;
}
.kpi-val .sep {
    margin: 0 6px;
    color: #ccc;
    font-weight: 400;
}
.kpi-val--dark {
    color: #262626;
}
.kpi-val--accent {
    color: #fa8c16;
}
.chart-row {
    margin-top: 4px;
}
.chart-panel {
    background: var(--kb-bg-card, #fff);
    border: 1px solid var(--kb-border, #e8e8e8);
    border-radius: 8px;
    padding: 14px 14px 6px;
    margin-bottom: 16px;
    box-shadow: var(--kb-shadow-card, 0 1px 4px rgba(0, 0, 0, 0.06));
}
.chart-panel.wide {
    padding-bottom: 8px;
}
.chart-title {
    font-size: 14px;
    font-weight: 600;
    color: #333;
    margin-bottom: 8px;
}
.chart-dom {
    width: 100%;
    height: 300px;
}
.chart-dom-tall {
    height: 340px;
}
.empty {
    opacity: 0.7;
    padding: 24px 0;
    text-align: center;
}
</style>
