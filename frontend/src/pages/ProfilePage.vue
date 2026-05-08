<template>
    <div class="kb-page">
        <el-card class="kb-card">
            <p class="sub">登录后从服务端拉取最新档案（EHR 同步字段），仅供查看。</p>
            <el-descriptions v-loading="meLoading" :column="1" border class="desc" size="default">
                <el-descriptions-item label="登录 ID">{{ auth.loginId || "—" }}</el-descriptions-item>
                <el-descriptions-item label="角色">
                    <el-tag v-if="auth.role === 'admin'" type="primary" size="small">管理员</el-tag>
                    <el-tag v-else type="info" size="small">用户</el-tag>
                </el-descriptions-item>
                <el-descriptions-item label="姓名">{{ auth.displayName || "—" }}</el-descriptions-item>
                <el-descriptions-item label="所属部门">{{ auth.ehrDeptname || "—" }}</el-descriptions-item>
                <el-descriptions-item label="员工编号 / empid">{{ auth.ehrEmpId || "—" }}</el-descriptions-item>
                <el-descriptions-item label="员工类型">{{ auth.ehrEmpType || "—" }}</el-descriptions-item>
                <el-descriptions-item label="驻地">{{ auth.ehrStaname || "—" }}</el-descriptions-item>
                <el-descriptions-item label="岗位">{{ auth.ehrJobname || "—" }}</el-descriptions-item>
                <el-descriptions-item label="手机">{{ auth.ehrMobile || "—" }}</el-descriptions-item>
            </el-descriptions>
        </el-card>
    </div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import { useAuthStore } from "../stores/auth";
import { api } from "../lib/api";

const store = useAuthStore();
const meLoading = ref(true);
const serverMe = ref(null);

const loadMe = async () => {
    meLoading.value = true;
    try {
        const res = await api.get("/users/me");
        if (res.data?.code === 200 && res.data?.data) serverMe.value = res.data.data;
        else serverMe.value = null;
    } catch {
        serverMe.value = null;
    } finally {
        meLoading.value = false;
    }
};

onMounted(() => void loadMe());

const auth = computed(() => {
    const s = serverMe.value;
    if (s) {
        return {
            loginId: s.loginId || store.loginId,
            role: store.role,
            displayName: s.displayName || "",
            ehrDeptname: s.ehrDeptname || "",
            ehrEmpId: s.ehrEmpId || "",
            ehrEmpType: s.ehrEmpType || "",
            ehrStaname: s.ehrStaname || "",
            ehrJobname: s.ehrJobname || "",
            ehrMobile: s.ehrMobile || ""
        };
    }
    return {
        loginId: store.loginId,
        role: store.role,
        displayName: store.displayName,
        ehrDeptname: store.ehrDeptname,
        ehrEmpId: store.ehrEmpId,
        ehrEmpType: store.ehrEmpType,
        ehrStaname: store.ehrStaname,
        ehrJobname: store.ehrJobname,
        ehrMobile: store.ehrMobile
    };
});
</script>

<style scoped>
.sub {
    margin: 0 0 16px;
    font-size: 13px;
    color: var(--kb-text-secondary, #666);
}
.desc {
    max-width: 560px;
}
</style>
