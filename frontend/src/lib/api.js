import axios from "axios";

/**
 * 统一为 …/api/v1：即使 VITE 只配了 origin（如 http://127.0.0.1:3001），也自动补上 /api/v1。
 * 开发环境且未显式配置 VITE_API_BASE_URL 时走相对路径 /api/v1，由 Vite 代理到 backend/.env 的 PORT（见 vite.config.js）。
 */
const normalizeApiBase = () => {
    const env = import.meta.env.VITE_API_BASE_URL;
    const isDevDefault = import.meta.env.DEV && (env === undefined || String(env).trim() === "");

    const apiBase = (() => {
        if (isDevDefault) return "/api/v1";
        const fallbackHost = "http://127.0.0.1:3001";
        const raw = String(env || fallbackHost).trim().replace(/\/+$/, "");
        if (raw.endsWith("/api/v1")) return raw;
        return `${raw}/api/v1`;
    })();

    // #region agent log
    if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.debug("[frontend] resolve apiBase", {
            dev: true,
            VITE_API_BASE_URL: String(env || ""),
            apiBase
        });
        fetch("/api/v1/__debug/client-log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                runId: "debug-iter3",
                hypothesisId: "H1",
                location: "frontend/src/lib/api.js:normalizeApiBase",
                message: "resolved API_BASE_URL",
                data: { dev: true, VITE_API_BASE_URL: String(env || ""), apiBase }
            })
        }).catch(() => {});
    }
    // #endregion

    return apiBase;
};

const API_BASE_URL = normalizeApiBase();

/** 与 auth store 一致，刷新页面后立刻恢复请求头（否则仅有 Pinia 里有 token） */
const TOKEN_KEY = "kb_token";

export const api = axios.create({
    baseURL: API_BASE_URL,
    timeout: 30000
});

try {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : "";
    if (saved) {
        api.defaults.headers.common.Authorization = `Bearer ${saved}`;
    }
} catch (_) {
    /* ignore */
}

/** 子页面 onMounted 可能早于 App注册 401 回调：每请求从 localStorage 同步 Bearer，避免头丢失或与 Pinia 不一致 */
api.interceptors.request.use((config) => {
    try {
        const t = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : "";
        if (t) {
            config.headers = config.headers || {};
            config.headers.Authorization = `Bearer ${t}`;
        }
    } catch (_) {
        /* ignore */
    }
    return config;
});

export const setAuthToken = (token) => {
    if (token) {
        api.defaults.headers.common.Authorization = `Bearer ${token}`;
    } else {
        delete api.defaults.headers.common.Authorization;
    }
};

/** 由 App.vue 注册：除登录/改密等业务 401 外，统一清 token 并回登录页 */
let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => {
    onUnauthorized = typeof fn === "function" ? fn : null;
};

api.interceptors.response.use(
    (r) => r,
    (err) => {
        const status = err.response?.status;
        if (status !== 401) return Promise.reject(err);
        const path = String(err.config?.url || "").split("?")[0];
        if (path.includes("/auth/login") || path.includes("/auth/change-password")) {
            return Promise.reject(err);
        }
        try {
            onUnauthorized?.();
        } catch (_) {
            /* ignore */
        }
        return Promise.reject(err);
    }
);

