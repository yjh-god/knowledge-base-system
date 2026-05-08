"""
验证 Docker 内的 Qdrant：检查 /readyz 后建集合、写向量、检索。
先启动: docker compose up -d
"""
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

from qdrant_local import get_client

COLLECTION = "demo_kb"
READYZ = "http://127.0.0.1:6333/readyz"


def _require_server() -> None:
    try:
        urllib.request.urlopen(READYZ, timeout=5)
    except (urllib.error.URLError, OSError) as e:
        print("无法连接 Qdrant:", e, file=sys.stderr)
        print("请先启动: docker compose up -d", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    _require_server()
    client: QdrantClient = get_client()

    if client.collection_exists(COLLECTION):
        client.delete_collection(COLLECTION)

    client.create_collection(
        collection_name=COLLECTION,
        vectors_config=VectorParams(size=4, distance=Distance.COSINE),
    )

    client.upsert(
        collection_name=COLLECTION,
        points=[
            PointStruct(id=1, vector=[0.1, 0.2, 0.3, 0.4], payload={"text": "hello qdrant"}),
            PointStruct(id=2, vector=[0.2, 0.1, 0.4, 0.3], payload={"text": "knowledge base"}),
        ],
    )

    hits = client.query_points(
        collection_name=COLLECTION,
        query=[0.15, 0.18, 0.35, 0.38],
        limit=2,
    ).points

    assert len(hits) >= 1, "expected at least one search hit"
    print("Qdrant OK (Docker)")
    print(f"  url: http://127.0.0.1:6333")
    print(f"  collection: {COLLECTION}")
    print(f"  top hit id={hits[0].id} score={hits[0].score} payload={hits[0].payload}")


if __name__ == "__main__":
    main()
