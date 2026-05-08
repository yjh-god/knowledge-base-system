import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const mdPath = path.join(repoRoot, "docs", "知识库开发PRD文档.md");
const base = process.env.API_BASE || "http://127.0.0.1:3001";

const testPwd = process.env.KB_TEST_PASSWORD;
if (!testPwd) {
    console.error("请设置环境变量 KB_TEST_PASSWORD（开源版不在脚本中写死口令）");
    process.exit(1);
}

const loginRes = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        loginId: "admin",
        password: testPwd,
        userDeptIds: ["101"]
    })
});
const loginJson = await loginRes.json();
if (loginJson.code !== 200) {
    console.error("login failed", loginJson);
    process.exit(1);
}
const token = loginJson.data?.token;

const buf = fs.readFileSync(mdPath);
const blob = new Blob([buf]);
const fd = new FormData();
fd.append("visibleDeptIds", JSON.stringify(["101"]));
fd.append("files", blob, path.basename(mdPath));

const upRes = await fetch(`${base}/api/v1/documents/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd
});
const upJson = await upRes.json();
console.log(JSON.stringify(upJson, null, 2));
