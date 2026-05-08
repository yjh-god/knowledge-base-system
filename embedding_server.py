import os
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import uvicorn

# 模型目录：通过环境变量配置，勿写死本机路径（见 README / .env.example）
MODEL_LOCAL_PATH = os.environ.get("EMBED_MODEL_LOCAL_PATH", "").strip()
if not MODEL_LOCAL_PATH:
    raise RuntimeError(
        "请设置环境变量 EMBED_MODEL_LOCAL_PATH 为本地 BGE-M3（或兼容）模型目录，"
        "或改用后端 .env 中的 EMBEDDING_API_BASE_URL 指向已部署的 Embedding 服务。"
    )

model = SentenceTransformer(MODEL_LOCAL_PATH, device="cpu")

app = FastAPI()


class EmbeddingRequest(BaseModel):
    input: list[str] | str
    model: str = "bge-m3"


@app.post("/v1/embeddings")
async def create_embedding(req: EmbeddingRequest):
    texts = req.input if isinstance(req.input, list) else [req.input]
    embeddings = model.encode(texts, normalize_embeddings=True)
    return {
        "data": [
            {"embedding": emb.tolist(), "index": i, "object": "embedding"}
            for i, emb in enumerate(embeddings)
        ],
        "model": "bge-m3",
    }


if __name__ == "__main__":
    print("本地 Embedding 服务启动成功: http://localhost:8902")
    uvicorn.run(app, host="0.0.0.0", port=8902)
