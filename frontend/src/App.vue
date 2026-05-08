<template>
    <div class="app" :class="{ 'app--shell': !isBarePage }">
        <!-- 登录等公开页：无侧栏 -->
        <router-view v-if="isBarePage" />

        <el-container v-else class="layout-root">
            <el-aside :width="asideWidth" class="aside">
                <div class="aside-brand" :class="{ collapsed: menuCollapsed }">
                    <img class="aside-logo" src="/favicon.png" alt="知识库" />
                    <div v-show="!menuCollapsed" class="aside-brand-title">品质中心知识库</div>
                </div>
                <el-menu
                    :default-active="activeMenu"
                    :collapse="menuCollapsed"
                    :collapse-transition="false"
                    router
                    class="side-menu"
                >
                    <div v-show="!menuCollapsed" class="menu-group-label">业务工作台</div>
                    <el-menu-item index="/">
                        <el-icon><Search /></el-icon>
                        <template #title>检索</template>
                    </el-menu-item>
                    <el-menu-item index="/documents">
                        <el-icon><FolderOpened /></el-icon>
                        <template #title>文档库</template>
                    </el-menu-item>
                    <el-menu-item index="/jobs">
                        <el-icon><List /></el-icon>
                        <template #title>任务</template>
                    </el-menu-item>
                    <el-menu-item index="/profile">
                        <el-icon><User /></el-icon>
                        <template #title>我的信息</template>
                    </el-menu-item>

                    <template v-if="authRole === 'admin'">
                        <div v-show="!menuCollapsed" class="menu-group-label">管理后台</div>
                        <el-menu-item index="/admin/dashboard">
                            <el-icon><DataLine /></el-icon>
                            <template #title>数据看板</template>
                        </el-menu-item>
                        <el-menu-item index="/admin/audit-logs">
                            <el-icon><Document /></el-icon>
                            <template #title>操作日志</template>
                        </el-menu-item>
                        <el-menu-item index="/admin/system">
                            <el-icon><Setting /></el-icon>
                            <template #title>系统管理</template>
                        </el-menu-item>
                        <el-menu-item index="/admin/knowledge-graph">
                            <el-icon><Connection /></el-icon>
                            <template #title>知识图谱</template>
                        </el-menu-item>
                        <el-menu-item index="/admin/sync-config">
                            <el-icon><Refresh /></el-icon>
                            <template #title>同步配置</template>
                        </el-menu-item>
                    </template>
                </el-menu>
                <div class="aside-foot">
                    <el-button text class="collapse-btn" @click="menuCollapsed = !menuCollapsed">
                        <el-icon><Fold v-if="!menuCollapsed" /><Expand v-else /></el-icon>
                    </el-button>
                    <div v-show="!menuCollapsed" class="aside-version">v1 · {{ buildDate }}</div>
                </div>
            </el-aside>

            <el-container direction="vertical" class="main-wrap">
                <el-header height="52px" class="topbar">
                    <div class="topbar-left">
                        <span class="page-hint">{{ pageTitle }}</span>
                    </div>
                    <div class="topbar-right">
                        <el-link
                            class="guide-link"
                            type="primary"
                            underline="never"
                            href="javascript:void(0)"
                            @click.prevent="onOpenGuide"
                        >
                            <el-icon class="guide-ic"><Document /></el-icon>
                            使用指南
                        </el-link>
                        <el-button
                            v-if="authRole === 'admin' && dashboardUrl"
                            type="primary"
                            plain
                            size="small"
                            @click="onOpenDashboard"
                        >
                            Qdrant 控制台
                        </el-button>
                        <el-dropdown
                            v-if="authToken && authLoginId"
                            trigger="click"
                            class="user-dropdown"
                            @command="onUserMenu"
                        >
                            <span class="user-trigger">
                                <el-avatar
                                    class="user-avatar"
                                    :size="36"
                                    :src="avatarEffectiveUrl"
                                    @error="onAvatarError"
                                >
                                    {{ avatarLetter }}
                                </el-avatar>
                                <span class="user-name">{{ topDisplayName }}</span>
                                <el-icon class="user-caret"><ArrowDown /></el-icon>
                            </span>
                            <template #dropdown>
                                <el-dropdown-menu>
                                    <el-dropdown-item command="profile">
                                        <el-icon><User /></el-icon>
                                        个人信息
                                    </el-dropdown-item>
                                    <el-dropdown-item command="password">
                                        <el-icon><Key /></el-icon>
                                        修改密码
                                    </el-dropdown-item>
                                    <el-dropdown-item divided command="logout">
                                        <el-icon><SwitchButton /></el-icon>
                                        退出登录
                                    </el-dropdown-item>
                                </el-dropdown-menu>
                            </template>
                        </el-dropdown>
                        <el-tag
                            v-if="authToken && authRole === 'admin'"
                            type="primary"
                            effect="light"
                            size="small"
                            class="admin-tag"
                            >管理员</el-tag
                        >
                        <RouterLink v-if="!authToken" class="login-link" to="/login">登录</RouterLink>
                    </div>
                </el-header>
                <el-main class="main">
                    <router-view />
                </el-main>
            </el-container>
        </el-container>

        <el-dialog
            v-model="pwdVisible"
            title="修改密码"
            width="420px"
            destroy-on-close
            @closed="resetPwdForm"
        >
            <el-form label-width="96px">
                <el-form-item label="当前密码">
                    <el-input v-model="pwdForm.oldPassword" type="password" show-password autocomplete="off" />
                </el-form-item>
                <el-form-item label="新密码">
                    <el-input v-model="pwdForm.newPassword" type="password" show-password autocomplete="off" />
                </el-form-item>
                <el-form-item label="确认新密码">
                    <el-input v-model="pwdForm.confirm" type="password" show-password autocomplete="off" />
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="pwdVisible = false">取消</el-button>
                <el-button type="primary" :loading="pwdLoading" @click="submitChangePassword">确定</el-button>
            </template>
        </el-dialog>
    </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
    ArrowDown,
    Connection,
    DataLine,
    Document,
    Expand,
    Fold,
    FolderOpened,
    Key,
    List,
    Refresh,
    Search,
    Setting,
    SwitchButton,
    User
} from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "./stores/auth";
import { api, setUnauthorizedHandler } from "./lib/api";

const authStore = useAuthStore();
const router = useRouter();
const route = useRoute();

onMounted(() => {
    setUnauthorizedHandler(() => {
        ElMessage.warning("登录已失效或 Token 已过期，请重新登录");
        authStore.logout();
        if (!route.meta?.public) router.replace("/login");
    });
});

const menuCollapsed = ref(false);
const asideWidth = computed(() => (menuCollapsed.value ? "64px" : "232px"));

const authToken = computed(() => authStore.token);
const authRole = computed(() => authStore.role);
const authLoginId = computed(() => authStore.loginId);
const dashboardUrl = computed(() => import.meta.env.VITE_QDRANT_DASHBOARD_PUBLIC_URL || "");

const topDisplayName = computed(() => authStore.displayName || authStore.loginId || "");
const avatarUrl = ref("");
const avatarBroken = ref(false);
const avatarEffectiveUrl = computed(() =>
    avatarUrl.value && !avatarBroken.value ? avatarUrl.value : undefined
);
const avatarLetter = computed(() => {
    const s = topDisplayName.value.trim();
    if (!s) return "?";
    return s.charAt(0).toUpperCase();
});

const loadAvatar = async () => {
    avatarBroken.value = false;
    if (!authStore.token) {
        avatarUrl.value = "";
        return;
    }
    try {
        const res = await api.get("/users/avatar");
        const u = res.data?.data?.avatarUrl;
        avatarUrl.value = typeof u === "string" && u.trim() ? u.trim() : "";
    } catch {
        avatarUrl.value = "";
    }
};

const onAvatarError = () => {
    avatarBroken.value = true;
};

watch(
    () => authStore.token,
    (t) => {
        if (t) void loadAvatar();
        else {
            avatarUrl.value = "";
            avatarBroken.value = false;
        }
    },
    { immediate: true }
);

const pwdVisible = ref(false);
const pwdLoading = ref(false);
const pwdForm = ref({ oldPassword: "", newPassword: "", confirm: "" });

const resetPwdForm = () => {
    pwdForm.value = { oldPassword: "", newPassword: "", confirm: "" };
};

const onUserMenu = (cmd) => {
    if (cmd === "profile") {
        router.push("/profile");
        return;
    }
    if (cmd === "password") {
        resetPwdForm();
        pwdVisible.value = true;
        return;
    }
    if (cmd === "logout") {
        onLogout();
    }
};

const submitChangePassword = async () => {
    const { oldPassword, newPassword, confirm } = pwdForm.value;
    if (!oldPassword || !newPassword) {
        ElMessage.warning("请填写当前密码与新密码");
        return;
    }
    if (newPassword.length < 3) {
        ElMessage.warning("新密码过短");
        return;
    }
    if (newPassword !== confirm) {
        ElMessage.warning("两次输入的新密码不一致");
        return;
    }
    pwdLoading.value = true;
    try {
        const res = await api.post("/auth/change-password", { oldPassword, newPassword });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "修改失败");
        ElMessage.success("密码已更新，请重新登录");
        pwdVisible.value = false;
        onLogout();
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "修改失败");
    } finally {
        pwdLoading.value = false;
    }
};

const buildDate = "2026-04";

const isBarePage = computed(() => route.meta.public === true);

const activeMenu = computed(() => route.path);

const pageTitle = computed(() => {
    const map = {
        "/": "检索",
        "/documents": "文档库",
        "/jobs": "任务",
        "/profile": "我的信息",
        "/admin/dashboard": "数据看板",
        "/admin/audit-logs": "操作日志",
        "/admin/system": "系统管理",
        "/admin/knowledge-graph": "知识图谱",
        "/admin/sync-config": "同步配置"
    };
    return map[route.path] || "";
});

const onOpenDashboard = () => {
    if (!dashboardUrl.value) return;
    window.open(dashboardUrl.value, "_blank", "noopener,noreferrer");
};

const onOpenGuide = () => {
    ElMessage.info("使用说明可后续挂载帮助文档或外链地址。");
};

const onLogout = () => {
    authStore.logout();
    router.push("/login");
};
</script>

<style scoped>
.app {
    padding: 0;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.app:not(.app--shell) {
    min-height: 100vh;
}
/* 有侧栏时锁定为视口高度，避免主区滚动把整个布局（含左侧菜单）顶出屏幕 */
.app.app--shell {
    height: 100%;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}
.layout-root {
    flex: 1;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    display: flex;
}
.aside {
    background: #fff;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--kb-border, #e8e8e8);
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.04);
    flex-shrink: 0;
    align-self: stretch;
    min-height: 0;
    overflow: hidden;
}
.aside-brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px 12px 14px;
    border-bottom: 1px solid var(--kb-border, #e8e8e8);
    min-height: auto;
}
.aside-brand.collapsed {
    padding: 14px 8px;
    gap: 0;
}
.aside-logo {
    display: block;
    width: auto;
    height: 40px;
    max-width: 100%;
    object-fit: contain;
    flex-shrink: 0;
}
.aside-brand.collapsed .aside-logo {
    height: 32px;
}
.aside-brand-title {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.35;
    text-align: center;
    color: var(--kb-text-title, #1a1a1a);
    letter-spacing: 0.02em;
    padding: 0 4px;
}
.side-menu {
    flex: 1;
    border-right: none !important;
    overflow-y: auto;
    --el-menu-bg-color: #fff;
    --el-menu-hover-bg-color: #f5f7fa;
    --el-menu-text-color: #606266;
    --el-menu-active-color: var(--kb-color-primary, #1890ff);
}
.menu-group-label {
    padding: 14px 16px 6px;
    font-size: 12px;
    color: #8c8c8c;
    font-weight: 500;
}
.aside-foot {
    padding: 8px 12px 12px;
    border-top: 1px solid var(--kb-border, #e8e8e8);
}
.collapse-btn {
    width: 100%;
    color: #8c8c8c !important;
}
.aside-version {
    margin-top: 6px;
    font-size: 11px;
    color: #bfbfbf;
    text-align: center;
}
.main-wrap {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--kb-bg-page, #f0f2f5);
}
.topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    background: #fff;
    border-bottom: 1px solid var(--kb-border, #e8e8e8);
}
.page-hint {
    font-size: 16px;
    font-weight: 600;
    color: var(--kb-text-title, #1a1a1a);
    letter-spacing: 0.02em;
}
.topbar-right {
    display: flex;
    align-items: center;
    gap: 14px;
}
.guide-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    font-weight: 500;
}
.guide-ic {
    font-size: 16px;
}
.user-dropdown {
    outline: none;
}
.user-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    outline: none;
}
.user-avatar {
    flex-shrink: 0;
    border: 1px solid #e8e8e8;
}
.user-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--kb-color-primary, #1890ff);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.user-caret {
    font-size: 12px;
    color: var(--kb-color-primary, #1890ff);
}
.admin-tag {
    margin-left: -4px;
}
.login-link {
    font-size: 14px;
    color: var(--kb-color-primary, #1890ff);
    text-decoration: none;
}
.main {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 0;
}
/* 各业务页根节点填满主区；具体谁内部滚动由页面类（.kb-page / .page / .page--search）决定 */
.main :deep(> *) {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
}
:deep(.el-menu-item.is-active) {
    background-color: var(--kb-sidebar-active-bg, #e6f4ff) !important;
    border-right: 3px solid var(--kb-color-primary, #1890ff);
    font-weight: 600;
}
:deep(.el-menu-item) {
    margin: 2px 8px;
    border-radius: 6px;
}
:deep(.el-menu--collapse .el-menu-item) {
    margin: 2px;
}
:deep(.user-dropdown .el-dropdown-menu__item) {
    display: flex;
    align-items: center;
    gap: 8px;
}
</style>
