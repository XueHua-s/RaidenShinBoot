"""Resolve and cache the embedding model without exposing hub details to the API."""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

import requests


DEFAULT_MODELSCOPE_ENDPOINT = "https://modelscope.cn"
DEFAULT_MODELSCOPE_MODEL = "AI-ModelScope/bge-small-zh-v1.5"


def resolve_model_path(public_model_id: str) -> str:
    source = os.getenv("EMBEDDING_MODEL_SOURCE", "huggingface").strip().lower()
    if source == "huggingface":
        return public_model_id
    if source == "local":
        local_path = os.getenv("EMBEDDING_MODEL_PATH", "").strip()
        if not local_path:
            raise RuntimeError("EMBEDDING_MODEL_PATH is required when EMBEDDING_MODEL_SOURCE=local")
        return local_path
    if source == "modelscope":
        return str(_ensure_modelscope_snapshot())
    raise RuntimeError("EMBEDDING_MODEL_SOURCE must be huggingface, modelscope, or local")


def _ensure_modelscope_snapshot() -> Path:
    endpoint = os.getenv("MODELSCOPE_ENDPOINT", DEFAULT_MODELSCOPE_ENDPOINT).rstrip("/")
    model_id = os.getenv("MODELSCOPE_MODEL_ID", DEFAULT_MODELSCOPE_MODEL).strip()
    revision = os.getenv("MODELSCOPE_MODEL_REVISION", "master").strip()
    cache_root = Path(os.getenv("EMBEDDING_MODEL_CACHE_DIR", "/models/embeddings"))
    target = cache_root / model_id.replace("/", "--")
    target.mkdir(parents=True, exist_ok=True)
    marker = target / ".snapshot-ready"
    cached_manifest_path = target / ".snapshot-manifest.json"
    cached_files = _read_cached_manifest(cached_manifest_path, model_id, revision)
    if cached_files:
        cached_fingerprint = _manifest_fingerprint(cached_files)
        if (
            marker.exists()
            and marker.read_text(encoding="utf-8").strip() == cached_fingerprint
            and _files_complete(target, cached_files)
        ):
            return target

    session = requests.Session()
    session.headers["user-agent"] = "RaidenShinBoot-Embedding/1"
    metadata_url = (
        f"{endpoint}/api/v1/models/{quote(model_id, safe='/')}/repo/files"
        f"?Revision={quote(revision, safe='')}&Recursive=true"
    )
    payload = _get_json_with_retries(session, metadata_url)
    files = _manifest_files(payload)
    fingerprint = _manifest_fingerprint(files)
    if marker.exists() and marker.read_text(encoding="utf-8").strip() == fingerprint and _files_complete(target, files):
        _write_cached_manifest(cached_manifest_path, model_id, revision, files)
        return target

    print(f"Downloading local embedding model from ModelScope: {model_id}@{revision}", flush=True)
    for item in files:
        relative_path = _safe_relative_path(item["Path"])
        destination = target / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        download_url = (
            f"{endpoint}/models/{quote(model_id, safe='/')}/resolve/"
            f"{quote(revision, safe='')}/{quote(item['Path'], safe='/')}"
        )
        _download_with_resume(
            session,
            download_url,
            destination,
            expected_size=item["Size"],
            expected_sha256=item["Sha256"],
        )

    _write_cached_manifest(cached_manifest_path, model_id, revision, files)
    _write_text_atomic(marker, fingerprint)
    return target


def _get_json_with_retries(session: requests.Session, url: str) -> Any:
    attempts = max(1, int(os.getenv("EMBEDDING_DOWNLOAD_ATTEMPTS", "8")))
    for attempt in range(1, attempts + 1):
        try:
            response = session.get(url, timeout=(10, 30))
            response.raise_for_status()
            return response.json()
        except Exception as error:
            if attempt >= attempts:
                raise RuntimeError(f"failed to load model manifest after {attempts} attempts") from error
            delay = min(30, 2**attempt)
            print(f"Model manifest attempt {attempt}/{attempts} failed; retrying in {delay}s", flush=True)
            time.sleep(delay)


def _manifest_files(payload: Any) -> list[dict[str, Any]]:
    raw_files = payload.get("Data", {}).get("Files", []) if isinstance(payload, dict) else []
    blobs = [item for item in raw_files if isinstance(item, dict) and item.get("Type") == "blob"]
    has_safetensors = any(item.get("Path") == "model.safetensors" for item in blobs)
    selected: list[dict[str, Any]] = []
    for item in blobs:
        path = item.get("Path")
        size = item.get("Size")
        sha256 = item.get("Sha256")
        if not isinstance(path, str) or not isinstance(size, int) or not isinstance(sha256, str):
            continue
        if path in {".gitattributes", "README.md"} or (has_safetensors and path == "pytorch_model.bin"):
            continue
        selected.append({"Path": path, "Size": size, "Sha256": sha256})
    if not selected or not any(item["Path"] in {"model.safetensors", "pytorch_model.bin"} for item in selected):
        raise RuntimeError("ModelScope returned an incomplete embedding model manifest")
    return sorted(selected, key=lambda item: item["Path"])


def _safe_relative_path(value: str) -> Path:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise RuntimeError(f"ModelScope returned an unsafe model path: {value}")
    return Path(*path.parts)


def _manifest_fingerprint(files: list[dict[str, Any]]) -> str:
    manifest = json.dumps(files, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(manifest.encode("utf-8")).hexdigest()


def _read_cached_manifest(path: Path, model_id: str, revision: str) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return []
    if not isinstance(payload, dict) or payload.get("model_id") != model_id or payload.get("revision") != revision:
        return []
    raw_files = payload.get("files")
    if not isinstance(raw_files, list):
        return []
    files: list[dict[str, Any]] = []
    try:
        for item in raw_files:
            if not isinstance(item, dict):
                return []
            file_path = item.get("Path")
            size = item.get("Size")
            sha256 = item.get("Sha256")
            if not isinstance(file_path, str) or not isinstance(size, int) or size < 0 or not isinstance(sha256, str):
                return []
            _safe_relative_path(file_path)
            files.append({"Path": file_path, "Size": size, "Sha256": sha256})
    except RuntimeError:
        return []
    return files


def _write_cached_manifest(
    path: Path,
    model_id: str,
    revision: str,
    files: list[dict[str, Any]],
) -> None:
    payload = json.dumps(
        {"version": 1, "model_id": model_id, "revision": revision, "files": files},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    _write_text_atomic(path, payload)


def _write_text_atomic(path: Path, value: str) -> None:
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)


def _files_complete(target: Path, files: list[dict[str, Any]]) -> bool:
    for item in files:
        path = target / _safe_relative_path(item["Path"])
        if not path.is_file() or path.stat().st_size != item["Size"]:
            return False
        if item["Sha256"] and _sha256(path).lower() != item["Sha256"].lower():
            return False
    return True


def _download_with_resume(
    session: requests.Session,
    url: str,
    destination: Path,
    *,
    expected_size: int,
    expected_sha256: str,
) -> None:
    if destination.exists() and destination.stat().st_size == expected_size:
        if not expected_sha256 or _sha256(destination) == expected_sha256:
            return
        destination.unlink()

    partial = destination.with_name(f"{destination.name}.part")
    attempts = max(1, int(os.getenv("EMBEDDING_DOWNLOAD_ATTEMPTS", "8")))
    read_timeout = max(10, int(os.getenv("EMBEDDING_DOWNLOAD_READ_TIMEOUT_SECONDS", "60")))
    for attempt in range(1, attempts + 1):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > expected_size:
                partial.unlink()
                offset = 0
            headers = {"range": f"bytes={offset}-"} if offset else {}
            with session.get(url, headers=headers, stream=True, timeout=(10, read_timeout)) as response:
                response.raise_for_status()
                append = offset > 0 and response.status_code == 206
                with partial.open("ab" if append else "wb") as output:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            output.write(chunk)
            if partial.stat().st_size != expected_size:
                raise RuntimeError(
                    f"downloaded {partial.stat().st_size} bytes for {destination.name}; expected {expected_size}"
                )
            if expected_sha256 and _sha256(partial) != expected_sha256:
                partial.unlink()
                raise RuntimeError(f"SHA-256 mismatch for {destination.name}")
            os.replace(partial, destination)
            print(f"Cached {destination.name} ({expected_size} bytes)", flush=True)
            return
        except Exception as error:
            if attempt >= attempts:
                raise RuntimeError(f"failed to download {destination.name} after {attempts} attempts") from error
            delay = min(30, 2**attempt)
            print(f"Download attempt {attempt}/{attempts} failed for {destination.name}; retrying in {delay}s", flush=True)
            time.sleep(delay)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
