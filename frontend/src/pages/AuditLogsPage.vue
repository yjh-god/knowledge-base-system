<template>
    <div class="page">
        <el-card class="kb-card" v-loading="loading">
            <el-form :inline="true" :model="filters" class="filters">
                <el-form-item label="操作类型">
                    <el-input v-model="filters.action" placeholder="如 doc.upload" clearable style="width: 160px" />
                </el-form-item>
                <el-form-item label="登录账号">
                    <el-input v-model="filters.actorLoginId" clearable style="width: 140px" />
                </el-form-item>
                <el-form-item label="开始日期">
                    <el-date-picker v-model="filters.from" type="date" value-format="YYYY-MM-DD" placeholder="开始" />
                </el-form-item>
                <el-form-item label="结束日期">
                    <el-date-picker v-model="filters.to" type="date" value-format="YYYY-MM-DD" placeholder="结束" />
                </el-form-item>
                <el-form-item label="摘要关键词">
                    <el-input v-model="filters.q" clearable style="width: 160px" />
                </el-form-item>
                <el-form-item>
                    <el-button type="primary" @click="onSearch">查询</el-button>
                </el-form-item>
            </el-form>

            <el-alert v-if="errorMsg" type="error" :title="errorMsg" show-icon :closable="false" class="mb" />

            <el-table
                :data="items"
                class="kb-table kb-data-table"
                stripe
                border
                table-layout="fixed"
                style="width: 100%"
            >
                <el-table-column type="expand">
                    <template #default="{ row }">
                        <pre class="meta">{{ formatMeta(row.metadata_json) }}</pre>
                    </template>
                </el-table-column>
                <el-table-column label="时间" width="168" header-align="center" align="center">
                    <template #default="{ row }">{{ formatDateTime(row.created_at) || "—" }}</template>
                </el-table-column>
                <el-table-column prop="id" label="编号" width="88" header-align="center" align="center" />
                <el-table-column prop="actor_login_id" label="用户" width="120" header-align="center" />
                <el-table-column label="操作" min-width="140" header-align="center">
                    <template #default="{ row }">
                        <span :title="row.action">{{ formatAuditAction(row.action) }}</span>
                    </template>
                </el-table-column>
                <el-table-column prop="target_type" label="目标类型" width="100" header-align="center" />
                <el-table-column
                    prop="target_id"
                    label="目标ID"
                    min-width="160"
                    header-align="center"
                    show-overflow-tooltip
                />
                <el-table-column prop="summary" label="摘要" min-width="180" header-align="center" show-overflow-tooltip />
            </el-table>

            <el-pagination
                v-model:current-page="page"
                v-model:page-size="pageSize"
                :total="total"
                layout="total, prev, pager, next, sizes"
                :page-sizes="[10, 20, 50, 100]"
                class="kb-pager"
                @current-change="load"
                @size-change="load"
            />
        </el-card>
    </div>
</template>

<script setup>
import { onMounted, reactive, ref } from "vue";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/datetimeFormat";
import { formatAuditAction } from "../lib/displayFormat";

const loading = ref(false);
const errorMsg = ref("");
const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);

const filters = reactive({
    action: "",
    actorLoginId: "",
    from: "",
    to: "",
    q: ""
});

const formatMeta = (raw) => {
    if (raw == null || raw === "") return "—";
    if (typeof raw === "object") {
        try {
            return JSON.stringify(raw, null, 2);
        } catch (_) {
            return String(raw);
        }
    }
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (_) {
        return String(raw);
    }
};

const load = async () => {
    loading.value = true;
    errorMsg.value = "";
    try {
        const params = {
            page: page.value,
            pageSize: pageSize.value
        };
        if (filters.action) params.action = filters.action;
        if (filters.actorLoginId) params.actorLoginId = filters.actorLoginId;
        if (filters.from) params.from = filters.from;
        if (filters.to) params.to = filters.to;
        if (filters.q) params.q = filters.q;

        const res = await api.get("/admin/audit-logs", { params });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "查询失败");
        items.value = res.data?.data?.items || [];
        total.value = res.data?.data?.total ?? 0;
    } catch (e) {
        errorMsg.value = e?.message || "加载失败";
        items.value = [];
    } finally {
        loading.value = false;
    }
};

const onSearch = () => {
    page.value = 1;
    load();
};

onMounted(load);
</script>

<style scoped>
.page {
    padding: 16px;
}
.filters {
    margin-bottom: 12px;
}
.meta {
    margin: 0;
    padding: 8px;
    background: #f8f8f8;
    border-radius: 4px;
    font-size: 12px;
    max-height: 200px;
    overflow: auto;
    white-space: pre-wrap;
}
.mb {
    margin-bottom: 12px;
}
</style>
