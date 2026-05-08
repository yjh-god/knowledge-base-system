<template>
    <div class="page">
        <el-card>
            <el-tabs>
                <el-tab-pane label="运行配置">
                    <el-descriptions v-loading="cfgLoading" :column="1" border>
                        <el-descriptions-item label="Qdrant 控制台">
                            <el-button
                                v-if="config.qdrantDashboardUrl"
                                type="primary"
                                @click="openUrl(config.qdrantDashboardUrl)"
                            >
                                打开控制台
                            </el-button>
                            <span v-else class="muted">未配置（后端 QDRANT_DASHBOARD_PUBLIC_URL）</span>
                        </el-descriptions-item>
                        <el-descriptions-item label="集合名">{{ config.qdrantCollection || "—" }}</el-descriptions-item>
                        <el-descriptions-item label="Embedding 模型">{{ config.embeddingModel || "—" }}</el-descriptions-item>
                    </el-descriptions>
                </el-tab-pane>

                <el-tab-pane label="API Key">
                    <el-form :inline="true" class="mb">
                        <el-form-item label="名称">
                            <el-input v-model="keyForm.name" style="width: 200px" placeholder="如 OpenClaw" />
                        </el-form-item>
                        <el-form-item label="绑定登录ID">
                            <el-input v-model="keyForm.boundLoginId" style="width: 160px" placeholder="users.login_id" />
                        </el-form-item>
                        <el-form-item>
                            <el-button type="primary" :loading="keyCreating" @click="createKey">创建</el-button>
                            <el-button @click="loadKeys">刷新列表</el-button>
                        </el-form-item>
                    </el-form>
                    <el-alert
                        v-if="newSecret"
                        type="success"
                        :title="'新密钥（仅显示一次）：' + newSecret"
                        show-icon
                        :closable="false"
                        class="mb"
                    />
                    <el-table v-loading="keysLoading" :data="keys" size="small" style="width: 100%">
                        <el-table-column prop="keyPrefix" label="前缀" width="140" />
                        <el-table-column prop="name" label="名称" />
                        <el-table-column prop="boundUserId" label="绑定用户" min-width="200" show-overflow-tooltip />
                        <el-table-column label="创建时间" min-width="170">
                            <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
                        </el-table-column>
                        <el-table-column label="操作" width="100">
                            <template #default="{ row }">
                                <el-button type="danger" text size="small" @click="revokeKey(row)">吊销</el-button>
                            </template>
                        </el-table-column>
                    </el-table>
                </el-tab-pane>

                <el-tab-pane label="向量对账">
                    <p class="muted">
                        与 PRD 夜间任务一致：对已删除文档再次清理 Qdrant、并抽样清理孤儿向量。默认由服务端
                        <code>node-cron</code> 在凌晨执行（<code>KB_NIGHT_BATCH_CRON</code>）；此处可<strong>立即手动触发</strong>。
                    </p>
                    <el-button type="primary" :loading="nightLoading" @click="runNightReconcile">
                        立即执行向量对账
                    </el-button>
                    <p v-if="nightResult" class="muted small pre-wrap">{{ nightResult }}</p>
                </el-tab-pane>

                <el-tab-pane label="EHR 同步">
                    <p class="muted">
                        手动触发组织与用户同步。<code>EHR_SYNC_SOURCE=mock</code> 为内置示例数据；
                        <code>EHR_SYNC_SOURCE=sql</code> 时从
                        <code>EHR_MSSQL_SERVER</code> / <code>EHR_MSSQL_DATABASE</code> 读取
                        <code>EHR_SYNC_FROM</code>（须含 empcode、empname、deptname1～deptname5）。
                        <code>EHR_SYNC_SOURCE=rest</code> 时请求 <code>EHR_REST_URL</code>（JSON 员工列表），可选
                        <code>EHR_REST_BEARER_TOKEN</code>。详见仓库
                        <code>docs/ehr-rest-sync.md</code>。同步后登录账号为
                        <strong>empcode</strong>，默认密码 <strong>123</strong>。
                    </p>
                    <p v-if="config.ehrSyncSource" class="muted small">
                        当前：source={{ config.ehrSyncSource }}
                        <span v-if="config.ehrMssqlServer"> · 源库 {{ config.ehrMssqlServer }} / {{ config.ehrMssqlDatabase || "—" }}</span>
                        <span v-if="config.ehrSyncFrom"> · {{ config.ehrSyncFrom }}</span>
                    </p>
                    <el-button type="primary" :loading="syncing" @click="runEhrSync">立即同步</el-button>
                </el-tab-pane>

                <el-tab-pane label="重置用户密码（管理员）">
                    <el-form :model="resetForm" label-width="120px" style="max-width: 480px">
                        <el-form-item label="登录 ID">
                            <el-input v-model="resetForm.loginId" />
                        </el-form-item>
                        <el-form-item label="新密码">
                            <el-input v-model="resetForm.password" type="password" show-password />
                        </el-form-item>
                        <el-form-item>
                            <el-button type="warning" :loading="resetting" @click="resetPwd">重置</el-button>
                        </el-form-item>
                    </el-form>
                </el-tab-pane>

                <el-tab-pane label="修改我的密码">
                    <el-form :model="pwdForm" label-width="120px" style="max-width: 480px">
                        <el-form-item label="旧密码">
                            <el-input v-model="pwdForm.oldPassword" type="password" show-password />
                        </el-form-item>
                        <el-form-item label="新密码">
                            <el-input v-model="pwdForm.newPassword" type="password" show-password />
                        </el-form-item>
                        <el-form-item>
                            <el-button type="primary" :loading="pwdLoading" @click="changePwd">保存</el-button>
                        </el-form-item>
                    </el-form>
                    <p class="muted">适用于已在 dbo.users 中签到的账号；开发环境仅 admin 可走登录接口时无本地用户记录。</p>
                </el-tab-pane>
            </el-tabs>
        </el-card>
    </div>
</template>

<script setup>
import { onMounted, reactive, ref } from "vue";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/datetimeFormat";
import { ElMessage, ElMessageBox } from "element-plus";

const cfgLoading = ref(false);
const config = reactive({
    qdrantDashboardUrl: "",
    qdrantCollection: "",
    embeddingModel: "",
    ehrSyncSource: "",
    ehrMssqlServer: "",
    ehrMssqlDatabase: "",
    ehrSyncFrom: ""
});

const keys = ref([]);
const keysLoading = ref(false);
const keyCreating = ref(false);
const newSecret = ref("");
const keyForm = reactive({ name: "", boundLoginId: "" });

const nightLoading = ref(false);
const nightResult = ref("");

const syncing = ref(false);
const resetting = ref(false);
const resetForm = reactive({ loginId: "", password: "" });

const pwdLoading = ref(false);
const pwdForm = reactive({ oldPassword: "", newPassword: "" });

const loadConfig = async () => {
    cfgLoading.value = true;
    try {
        const res = await api.get("/admin/config");
        if (res.data?.code === 200) {
            Object.assign(config, res.data.data || {});
        } else {
            ElMessage.error(res.data?.msg || "加载配置失败");
        }
    } catch (e) {
        const msg =
            e?.response?.data?.msg ||
            (e?.response?.status ? `HTTP ${e.response.status}` : "") ||
            e?.message ||
            "加载配置失败";
        ElMessage.error(msg);
    } finally {
        cfgLoading.value = false;
    }
};

const openUrl = (u) => {
    if (u) window.open(u, "_blank", "noopener,noreferrer");
};

const loadKeys = async () => {
    keysLoading.value = true;
    newSecret.value = "";
    try {
        const res = await api.get("/admin/api-keys");
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "读取失败");
        keys.value = res.data?.data?.items || [];
    } catch (e) {
        ElMessage.error(e?.message || "读取 API Key 失败");
    } finally {
        keysLoading.value = false;
    }
};

const createKey = async () => {
    if (!keyForm.name || !keyForm.boundLoginId) {
        ElMessage.warning("请填写名称与绑定登录ID");
        return;
    }
    keyCreating.value = true;
    try {
        const res = await api.post("/admin/api-keys", {
            name: keyForm.name,
            boundLoginId: keyForm.boundLoginId
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "创建失败");
        newSecret.value = res.data?.data?.secret || "";
        ElMessage.success("已创建");
        await loadKeys();
    } catch (e) {
        ElMessage.error(e?.message || "创建失败");
    } finally {
        keyCreating.value = false;
    }
};

const revokeKey = async (row) => {
    try {
        await ElMessageBox.confirm("确认吊销该 Key？", "提示", { type: "warning" });
    } catch {
        return;
    }
    try {
        const res = await api.post(`/admin/api-keys/${row.id}/revoke`);
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "失败");
        ElMessage.success("已吊销");
        await loadKeys();
    } catch (e) {
        ElMessage.error(e?.message || "吊销失败");
    }
};

const runNightReconcile = async () => {
    nightLoading.value = true;
    nightResult.value = "";
    try {
        const res = await api.post("/admin/night-reconcile");
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "失败");
        nightResult.value = JSON.stringify(res.data?.data || {}, null, 2);
        ElMessage.success("对账已执行");
    } catch (e) {
        ElMessage.error(e?.message || "对账失败");
    } finally {
        nightLoading.value = false;
    }
};

const runEhrSync = async () => {
    syncing.value = true;
    try {
        const res = await api.post("/admin/ehr-sync");
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "失败");
        ElMessage.success("同步完成");
    } catch (e) {
        ElMessage.error(e?.message || "同步失败");
    } finally {
        syncing.value = false;
    }
};

const resetPwd = async () => {
    if (!resetForm.loginId) {
        ElMessage.warning("填写登录 ID");
        return;
    }
    if (!resetForm.password || !String(resetForm.password).trim()) {
        ElMessage.warning("请填写新密码（开源版不再使用默认口令）");
        return;
    }
    resetting.value = true;
    try {
        const res = await api.post(`/admin/users/${encodeURIComponent(resetForm.loginId)}/reset-password`, {
            password: resetForm.password
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "失败");
        ElMessage.success("已重置");
    } catch (e) {
        ElMessage.error(e?.message || "重置失败");
    } finally {
        resetting.value = false;
    }
};

const changePwd = async () => {
    pwdLoading.value = true;
    try {
        const res = await api.post("/auth/change-password", {
            oldPassword: pwdForm.oldPassword,
            newPassword: pwdForm.newPassword
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "失败");
        ElMessage.success("密码已更新");
        pwdForm.oldPassword = "";
        pwdForm.newPassword = "";
    } catch (e) {
        ElMessage.error(e?.message || "修改失败");
    } finally {
        pwdLoading.value = false;
    }
};

onMounted(async () => {
    await loadConfig();
    await loadKeys();
});
</script>

<style scoped>
.page {
    padding: 16px;
}
.muted {
    opacity: 0.75;
    font-size: 13px;
}
.mb {
    margin-bottom: 12px;
}
.small {
    font-size: 12px;
}
.pre-wrap {
    white-space: pre-wrap;
    margin-top: 12px;
    max-height: 280px;
    overflow: auto;
}
</style>
