import { createRouter, createWebHistory } from "vue-router";
import LoginPage from "../pages/LoginPage.vue";
import SearchPage from "../pages/SearchPage.vue";
import DocumentsPage from "../pages/DocumentsPage.vue";
import JobsPage from "../pages/JobsPage.vue";
import DashboardPage from "../pages/DashboardPage.vue";
import AuditLogsPage from "../pages/AuditLogsPage.vue";
import SystemAdminPage from "../pages/SystemAdminPage.vue";
import KnowledgeGraphPage from "../pages/KnowledgeGraphPage.vue";
import SyncConfigPage from "../pages/SyncConfigPage.vue";
import ProfilePage from "../pages/ProfilePage.vue";
import { useAuthStore } from "../stores/auth";

const routes = [
    { path: "/login", name: "login", component: LoginPage, meta: { public: true } },
    { path: "/", name: "search", component: SearchPage, meta: { requiresAuth: true } },
    { path: "/documents", name: "documents", component: DocumentsPage, meta: { requiresAuth: true } },
    { path: "/jobs", name: "jobs", component: JobsPage, meta: { requiresAuth: true } },
    { path: "/profile", name: "profile", component: ProfilePage, meta: { requiresAuth: true } },
    {
        path: "/admin/dashboard",
        name: "adminDashboard",
        component: DashboardPage,
        meta: { requiresAuth: true, requiresAdmin: true }
    },
    {
        path: "/admin/audit-logs",
        name: "adminAudit",
        component: AuditLogsPage,
        meta: { requiresAuth: true, requiresAdmin: true }
    },
    {
        path: "/admin/system",
        name: "adminSystem",
        component: SystemAdminPage,
        meta: { requiresAuth: true, requiresAdmin: true }
    },
    {
        path: "/admin/knowledge-graph",
        name: "adminKnowledgeGraph",
        component: KnowledgeGraphPage,
        meta: { requiresAuth: true, requiresAdmin: true }
    },
    {
        path: "/admin/sync-config",
        name: "adminSyncConfig",
        component: SyncConfigPage,
        meta: { requiresAuth: true, requiresAdmin: true }
    }
];

export const router = createRouter({
    history: createWebHistory(),
    routes
});

router.beforeEach((to) => {
    const authStore = useAuthStore();
    const token = authStore.token;

    if (to.meta.public) {
        if (token && to.name === "login") {
            return { path: "/" };
        }
        return true;
    }

    if (!token) {
        return { name: "login" };
    }

    if (to.meta.requiresAdmin && authStore.role !== "admin") {
        return { path: "/" };
    }

    return true;
});

