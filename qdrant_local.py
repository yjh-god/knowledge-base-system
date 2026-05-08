"""连接 Docker 中运行的 Qdrant HTTP 服务（默认 http://127.0.0.1:6333）。"""
import os

from qdrant_client import QdrantClient

_DEFAULT_URL = "http://127.0.0.1:6333"


def get_client(url: str | None = None) -> QdrantClient:
    resolved = url or os.environ.get("QDRANT_URL", _DEFAULT_URL)
    return QdrantClient(url=resolved)
