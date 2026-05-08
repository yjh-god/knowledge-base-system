import { defineStore } from "pinia";
import { api, setAuthToken } from "../lib/api";

const TOKEN_KEY = "kb_token";
/** 与 SearchPage 一致：退出登录清空本轮对话缓存 */
export const KB_CHAT_SESSION_KEY = "kb_chat_session";
/** 检索页：混合 / AI答复 / 深度思考 / 调试 / TopK，随会话保留 */
export const KB_SEARCH_PREFS_KEY = "kb_search_prefs";

/** JWT payload 为 UTF-8 JSON；勿用 atob 结果直接 JSON.parse，否则中文 displayName 会乱码 */
export const parseJwtPayload = (token) => {
    if (!token) return null;
    try {
        const payloadPart = token.split(".")[1];
        if (!payloadPart) return null;
        let base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
        const pad = base64.length % 4;
        if (pad) base64 += "=".repeat(4 - pad);
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        const json = new TextDecoder("utf-8").decode(bytes);
        return JSON.parse(json);
    } catch (e) {
        return null;
    }
};

/** 供路由守卫使用：exp 到期则视为未登录（允许数秒时钟偏差） */
export const isJwtExpired = (token) => {
    const p = parseJwtPayload(token);
    if (!p || p.exp == null) return false;
    const expMs = Number(p.exp) * 1000;
    if (!Number.isFinite(expMs)) return false;
    return expMs < Date.now() - 5000;
};

export const useAuthStore = defineStore("auth", {
    state: () => ({
        token: localStorage.getItem(TOKEN_KEY) || ""
    }),
    getters: {
        role: (state) => parseJwtPayload(state.token)?.role || "",
        loginId: (state) => parseJwtPayload(state.token)?.loginId || "",
        displayName: (state) => parseJwtPayload(state.token)?.displayName || "",
        ehrDeptname: (state) => parseJwtPayload(state.token)?.ehrDeptname || "",
        ehrEmpId: (state) => parseJwtPayload(state.token)?.ehrEmpId || "",
        ehrEmpType: (state) => parseJwtPayload(state.token)?.ehrEmpType || "",
        ehrStaname: (state) => parseJwtPayload(state.token)?.ehrStaname || "",
        ehrJobname: (state) => parseJwtPayload(state.token)?.ehrJobname || "",
        ehrMobile: (state) => parseJwtPayload(state.token)?.ehrMobile || ""
    },
    actions: {
        async login({ loginId, password, userDeptIds, deptIds }) {
            try {
                const res = await api.post("/auth/login", {
                    loginId,
                    password,
                    ...(Array.isArray(userDeptIds) ? { userDeptIds } : {}),
                    ...(Array.isArray(deptIds) ? { deptIds } : {})
                });
                if (res.data?.code !== 200) {
                    throw new Error(res.data?.msg || "登录失败");
                }
                const token = res.data?.data?.token;
                if (!token) throw new Error("登录返回 token 为空");

                this.token = token;
                localStorage.setItem(TOKEN_KEY, token);
                setAuthToken(token);
            } catch (e) {
                const status = e?.response?.status;
                const serverMsg = e?.response?.data?.msg;
                const friendly =
                    (typeof serverMsg === "string" && serverMsg.trim()) ||
                    (status === 401
                        ? "账号或密码错误，请确认登录 ID 与密码是否正确"
                        : null) ||
                    (status === 400 ? "请检查登录信息是否填写完整" : null) ||
                    (typeof e?.message === "string" && !/^Request failed with status code \d+$/i.test(e.message)
                        ? e.message
                        : null) ||
                    "登录失败，请稍后重试";
                throw new Error(friendly);
            }
        },
        logout() {
            this.token = "";
            localStorage.removeItem(TOKEN_KEY);
            setAuthToken("");
            try {
                sessionStorage.removeItem(KB_CHAT_SESSION_KEY);
                sessionStorage.removeItem(KB_SEARCH_PREFS_KEY);
            } catch (_) {
                /* ignore */
            }
        }
    }
});

