<template>
    <div class="wrap">
        <div class="brand-panel">
            <div class="brand-row">
                <img class="brand-logo" src="/favicon.png" alt="" />
                <div class="brand-titles">
                <div class="brand-cn">品质中心</div>
                <div class="brand-en">Knowledge Base</div>
                </div>
            </div>
            <h1 class="system-title">企业知识库系统</h1>
            <p class="system-sub">智能检索与管理</p>
        </div>

        <el-card class="card">
            <h2 class="h2">用户登录</h2>
            <el-form :model="form" label-width="90px" @submit.prevent>
                <el-form-item label="登录ID">
                    <el-input v-model="form.loginId" placeholder="请输入登录ID" />
                </el-form-item>
                <el-form-item label="密码">
                    <el-input
                        v-model="form.password"
                        type="password"
                        placeholder="请输入密码"
                        show-password
                    />
                </el-form-item>
                <el-form-item>
                    <el-button type="primary" :loading="loading" @click="onLogin">登录</el-button>
                </el-form-item>
            </el-form>
            <div class="hint">
                开发环境默认账号：<code>{{ devLoginId }}</code>，默认密码：<code>{{ devPassword }}</code>
            </div>
        </el-card>
    </div>
</template>

<script setup>
import { reactive, computed } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const authStore = useAuthStore();

const form = reactive({
    loginId: import.meta.env.VITE_DEV_LOGIN_ID || "admin",
    password: import.meta.env.VITE_DEV_PASSWORD || ""
});

const loading = computed(() => false);
const onLogin = async () => {
    try {
        await authStore.login({
            loginId: form.loginId,
            password: form.password
        });
        router.push("/");
    } catch (e) {
        ElMessage.error(e?.message || "登录失败");
    }
};

const devLoginId = computed(() => import.meta.env.VITE_DEV_LOGIN_ID || "admin");
const devPassword = computed(() => import.meta.env.VITE_DEV_PASSWORD || "（未配置：在 frontend/.env.development 设置 VITE_DEV_PASSWORD）");
</script>

<style scoped>
.wrap {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 28px;
    padding: 24px 16px;
    background: linear-gradient(180deg, #f7f9fc 0%, #eef1f6 100%);
}
.brand-panel {
    text-align: center;
    max-width: 420px;
}
.brand-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin-bottom: 16px;
}
.brand-logo {
    width: 72px;
    height: 72px;
    object-fit: contain;
    flex-shrink: 0;
}
.brand-titles {
    text-align: left;
}
.brand-cn {
    font-size: 22px;
    font-weight: 700;
    color: #1a1a1a;
    letter-spacing: 0.04em;
}
.brand-en {
    margin-top: 4px;
    font-size: 13px;
    color: #595959;
    font-weight: 500;
}
.system-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: #262626;
    letter-spacing: 0.02em;
}
.system-sub {
    margin: 8px 0 0;
    font-size: 13px;
    color: #8c8c8c;
}
.card {
    width: 100%;
    max-width: 420px;
    border: 1px solid var(--kb-border, #e8e8e8);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
}
.h2 {
    margin: 0 0 16px 0;
    font-size: 17px;
    font-weight: 600;
    color: #262626;
}
.hint {
    margin-top: 12px;
    font-size: 12px;
    opacity: 0.8;
}
</style>
