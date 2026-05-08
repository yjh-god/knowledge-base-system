# 品质中心知识库系统

部门级知识库：**文档上传与解析**、**向量化入库（Qdrant）**、**混合检索（向量 + 关键字）**，可选 **大模型总结（RAG / OpenAI 兼容接口）**。包含登录鉴权、部门数据范围、管理端（审计、API Key、EHR 同步、镜像同步、知识图谱等）。

## 技术栈

| 部分 | 说明 |
|------|------|
| 前端 | Vue 3 + Vite + Element Plus + Pinia + Vue Router（`frontend/`） |
| 后端 | Node.js + Express（`backend/`，入口 `backend/src/index.js`） |
| 数据库 | Microsoft SQL Server（迁移脚本 `backend/sql/`） |
| 向量库 | Qdrant（Docker，见仓库内 `docker-compose` 等配置） |
| Embedding | 可选本机 `embedding_server.py`（需配置 `EMBED_MODEL_LOCAL_PATH`）或远端 `EMBEDDING_API_BASE_URL` |

## 快速开始

1. 安装依赖：

```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

2. 复制根目录 **`.env.example`**，按注释填写并放到运行所需位置（后端通常使用 **`backend/.env`**，与本地交接约定一致）。**切勿将含真实口令的 `.env` 提交到 Git。**

3. 启动 Qdrant（按项目内 Docker 配置），再执行：

```bash
npm run dev
```

默认前端开发端口 **5173**、后端 **3001**（以实际 `.env` 为准）。

## 交接与运维

更完整的部署顺序、端口、sqlcmd、防火墙与可选组件说明见 **`交接注意事项.txt`**（若与本仓库一并保管）。

## 开源说明

本仓库为可公开的源码副本：**不含** `node_modules`、`.venv`、真实 `.env` 及本地构建产物中的敏感默认值；部署生产前请更换所有密钥并配置 **HTTPS / CORS / 最小权限数据库账号**。

## 许可证

以各 `package.json` 中的 `license` 为准；若未指定，请自行补充许可证文件。
