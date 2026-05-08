/** 将接口返回的 ISO / datetimeoffset 字符串格式化为本地时间 YYYY-MM-DD HH:mm:ss */
export const formatDateTime = (value) => {
    if (value == null || value === "") return "";
    const d = new Date(typeof value === "string" ? value.replace(" ", "T") : value);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
