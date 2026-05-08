# 品质中心知识库系统（开源脱敏版）

部门知识库：文档上传与解析、向量化入库（**Qdrant**）、混合检索（向量 + 关键字）、可选大模型总结（RAG）。含登录鉴权、部门范围、管理端（审计、API Key、EHR 同步、镜像同步、知识图谱等）。

本目录为从交接源码复制的 **GitHub 友好版本**：已剔除 `.env`、构建产物、调试脚本中的敏感默认值，并将示例文档中的内网 IP / Webhook 示例替换为占位符。**请勿将真实 `backend/.env` 提交到 Git。**

更完整的交接说明见根目录 **`交接注意事项.txt`**。

## 技术栈

- 前端：`frontend/` — Vue 3 + Vite + Element Plus + Pinia + Vue Router  
- 后端：`backend/` — Node.js + Express（入口 `backend/src/index.js`）  
- 向量库：Qdrant（`docker compose` 见仓库内配置）  
- 可选本地 Embedding：`embedding_server.py`（需配置 **`EMBED_MODEL_LOCAL_PATH`**）

业务库：**SQL Server**（脚本在 `backend/sql/`，按编号顺序执行）。

## 快速开始

1. 安装依赖（建议在仓库根目录分别安装根脚本依赖、backend、frontend）：

```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

2. 配置环境变量：

- 复制根目录 **`.env.example`** 为 **`.env`**，并按注释填写 **数据库、JWT、Qdrant、Embedding / vLLM** 等。
- 后端实际运行时多数脚本会从 **`backend/.env`** 读取（与交接文档一致）；请在该目录放置你自己的 `.env`，**不要提交**。
- 本地跑 `embedding_server.py` 前设置 **`EMBED_MODEL_LOCAL_PATH`** 指向本机已下载的模型目录；或改用 **`EMBEDDING_API_BASE_URL`** 指向已有 Embedding 服务。

3. 启动 Qdrant（示例）：

```bash
docker compose up -d qdrant
```

4. 开发一键启动（Windows / 非 Windows 脚本见 `package.json` 与 `scripts/`）：

```bash
npm run dev
```

前端开发默认 **5173**，后端默认 **3001**（以 `.env` 为准）。

## 开源脱敏说明（相对交接原版）

- 未包含 **`node_modules` / `.venv`**；不含 **`backend/.env`**、根目录 `.env`。  
- 已删除 **`frontend/dist`**（请本地 `npm run build`）。  
- 已删除含本地调试口令的 **`backend/scripts/debug-*.cjs`**。  
- **`embedding_server.py`** 不再硬编码模型路径，依赖 **`EMBED_MODEL_LOCAL_PATH`**。  
- 管理端重置密码、登录页默认口令、模拟上传脚本等 **不再内置弱口令 `123`**，请用环境变量显式配置。  
- 文档中的示例 IP、连接串等已改为占位符；PRD 中涉及业务的「默认初始口令」描述仍为产品设计信息，**部署时请改用强口令与密钥管理**。

## 许可证

以各 `package.json` 中的 `license` 字段为准（若未指定，部署前请自行补充）。
