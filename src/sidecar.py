"""Per-session warm sidecar for pi-memsearch auto-context (ADR 0005).

JSON-lines protocol over stdio, spawned with cwd set to the project scope dir so
memsearch's config layering resolves identically to the CLI. The embedding provider
is constructed once and held for the process lifetime; every search opens a
throwaway MilvusStore so the directory-wide Milvus Lite lock is borrowed, never held.

stdin:  {"id": <any>, "query": str, "collection": str, "top_k": int}
stdout: {"event": "ready", "provider": str, "model": str}   once, after warmup
        {"id": <any>, "hits": [...]} | {"id": <any>, "error": str}
Exits when stdin reaches EOF. `--probe` verifies the memsearch internals this
script imports (the contract-test hook) without loading a model or opening a store.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import sys
from typing import Any


MILVUS_COLLECTION_NOT_FOUND = 100


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload), flush=True)


def _is_missing_collection(error: BaseException) -> bool:
    return getattr(error, "code", None) == MILVUS_COLLECTION_NOT_FOUND


def _open_store(config: Any, collection: str) -> Any:
    from memsearch.store import MilvusStore

    return MilvusStore(
        config.milvus.uri,
        token=config.milvus.token or None,
        collection=collection,
        dimension=None,
    )


async def _search(request: dict[str, Any], config: Any, provider: Any) -> list[dict[str, Any]]:
    query = request["query"]
    embedded, store = await asyncio.gather(
        provider.embed([query]),
        asyncio.to_thread(_open_store, config, request["collection"]),
        return_exceptions=True,
    )
    if isinstance(store, BaseException):
        raise store
    try:
        if isinstance(embedded, BaseException):
            raise embedded
        return store.search(embedded[0], query_text=query, top_k=int(request.get("top_k", 3)))
    finally:
        store.close()


async def _handle(request: dict[str, Any], config: Any, provider: Any) -> dict[str, Any]:
    request_id = request.get("id")
    try:
        hits = await _search(request, config, provider)
        return {"id": request_id, "hits": hits}
    except Exception as error:
        if _is_missing_collection(error):
            return {"id": request_id, "hits": []}
        return {"id": request_id, "error": f"{type(error).__name__}: {error}"}


async def _serve() -> None:
    from memsearch.config import resolve_config
    from memsearch.embeddings import get_provider

    config = resolve_config()
    provider = get_provider(
        config.embedding.provider,
        model=config.embedding.model or None,
        batch_size=config.embedding.batch_size,
        base_url=config.embedding.base_url or None,
        api_key=config.embedding.api_key or None,
    )
    _emit({"event": "ready", "provider": config.embedding.provider, "model": provider.model_name})

    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if line == "":
            return
        stripped = line.strip()
        if not stripped:
            continue
        try:
            request = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        _emit(await _handle(request, config, provider))


def _require_params(signature: inspect.Signature, names: set[str], target: str) -> None:
    missing = names - set(signature.parameters)
    if missing:
        raise RuntimeError(f"memsearch internals drifted: {target} lost parameter(s) {sorted(missing)}")


def _probe() -> None:
    from memsearch.config import resolve_config
    from memsearch.embeddings import EmbeddingProvider, get_provider
    from memsearch.store import MilvusStore

    _require_params(
        inspect.signature(get_provider),
        {"name", "model", "batch_size", "base_url", "api_key"},
        "memsearch.embeddings.get_provider",
    )
    if not inspect.iscoroutinefunction(EmbeddingProvider.embed):
        raise RuntimeError("memsearch internals drifted: EmbeddingProvider.embed is no longer an async method")
    if not hasattr(EmbeddingProvider, "model_name"):
        raise RuntimeError("memsearch internals drifted: EmbeddingProvider lost the model_name property")
    _require_params(
        inspect.signature(MilvusStore.__init__),
        {"uri", "token", "collection", "dimension"},
        "memsearch.store.MilvusStore.__init__",
    )
    _require_params(
        inspect.signature(MilvusStore.search),
        {"query_embedding", "query_text", "top_k"},
        "memsearch.store.MilvusStore.search",
    )
    if not callable(MilvusStore.close):
        raise RuntimeError("memsearch internals drifted: MilvusStore.close is not callable")

    config = resolve_config()
    _ = (
        config.embedding.provider,
        config.embedding.model,
        config.embedding.batch_size,
        config.embedding.base_url,
        config.embedding.api_key,
        config.milvus.uri,
        config.milvus.token,
    )
    _emit({"event": "probe-ok"})


def main() -> None:
    if "--probe" in sys.argv[1:]:
        _probe()
        return
    asyncio.run(_serve())


if __name__ == "__main__":
    main()
