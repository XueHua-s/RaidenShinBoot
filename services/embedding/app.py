#!/usr/bin/env python3
"""Small OpenAI-compatible embedding service for RaidenShinBoot.

The process owns the local model and batching details. Node callers only depend
on POST /v1/embeddings, so the backend can later move to ONNX or Paddle without
changing conversation or memory code.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import torch
from sentence_transformers import SentenceTransformer

from model_cache import resolve_model_path


MODEL_ID = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
EXPECTED_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "512"))
MAX_BATCH_SIZE = int(os.getenv("EMBEDDING_MAX_BATCH_SIZE", "256"))
MAX_INPUT_CHARS = int(os.getenv("EMBEDDING_MAX_INPUT_CHARS", "8192"))
MAX_REQUEST_BYTES = int(os.getenv("EMBEDDING_MAX_REQUEST_BYTES", str(2 * 1024 * 1024)))
HOST = os.getenv("EMBEDDING_HOST", "127.0.0.1")
PORT = int(os.getenv("EMBEDDING_PORT", "8080"))
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "64"))
TORCH_THREADS = int(os.getenv("EMBEDDING_TORCH_THREADS", str(max(1, min(4, os.cpu_count() or 1)))))

torch.set_num_threads(TORCH_THREADS)
MODEL = SentenceTransformer(resolve_model_path(MODEL_ID), device="cpu")
MODEL_LOCK = threading.Lock()


def embed_texts(texts: list[str]) -> list[list[float]]:
    with MODEL_LOCK:
        vectors = MODEL.encode(
            texts,
            batch_size=min(BATCH_SIZE, len(texts)),
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
    if vectors.ndim == 1:
        vectors = vectors.reshape(1, -1)
    if vectors.shape[1] != EXPECTED_DIMENSIONS:
        raise RuntimeError(
            f"model {MODEL_ID} returned {vectors.shape[1]} dimensions; expected {EXPECTED_DIMENSIONS}"
        )
    return vectors.astype("float32", copy=False).tolist()


def token_count(texts: list[str]) -> int:
    tokenizer = getattr(MODEL, "tokenizer", None)
    if tokenizer is None:
        return sum(max(1, len(text) // 2) for text in texts)
    return sum(len(tokenizer.encode(text, add_special_tokens=True)) for text in texts)


class EmbeddingHandler(BaseHTTPRequestHandler):
    server_version = "RaidenEmbedding/1"

    def do_GET(self) -> None:  # noqa: N802
        if self.path in {"/health", "/ready"}:
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "model": MODEL_ID,
                    "dimensions": EXPECTED_DIMENSIONS,
                    "device": "cpu",
                    "normalized": True,
                },
            )
            return
        self.send_error_json(HTTPStatus.NOT_FOUND, "not_found", "Route not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/embeddings":
            self.send_error_json(HTTPStatus.NOT_FOUND, "not_found", "Route not found")
            return
        try:
            payload = self.read_json()
            texts = validate_input(payload)
            started = time.perf_counter()
            vectors = embed_texts(texts)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
            tokens = token_count(texts)
            self.send_json(
                HTTPStatus.OK,
                {
                    "object": "list",
                    "data": [
                        {"object": "embedding", "index": index, "embedding": vector}
                        for index, vector in enumerate(vectors)
                    ],
                    "model": MODEL_ID,
                    "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
                    "local": {"elapsed_ms": elapsed_ms, "dimensions": EXPECTED_DIMENSIONS},
                },
            )
        except RequestError as error:
            self.send_error_json(error.status, error.code, str(error))
        except Exception as error:  # Keep model/library details out of HTTP responses.
            print(f"embedding request failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "embedding_failed", "Local embedding failed")

    def read_json(self) -> dict[str, Any]:
        raw_length = self.headers.get("content-length", "")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid_request", "Invalid Content-Length") from error
        if length < 1 or length > MAX_REQUEST_BYTES:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request_too_large", "Request body is too large")
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid_json", "Request body must be valid JSON") from error
        if not isinstance(payload, dict):
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid_request", "Request body must be an object")
        return payload

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: HTTPStatus, code: str, message: str) -> None:
        self.send_json(status, {"error": {"code": code, "message": message, "type": "local_embedding_error"}})

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} {fmt % args}", flush=True)


class RequestError(ValueError):
    def __init__(self, status: HTTPStatus, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def validate_input(payload: dict[str, Any]) -> list[str]:
    requested_model = payload.get("model")
    if requested_model not in {None, MODEL_ID}:
        raise RequestError(HTTPStatus.BAD_REQUEST, "model_not_found", f"Only {MODEL_ID} is loaded")
    if payload.get("encoding_format", "float") != "float":
        raise RequestError(HTTPStatus.BAD_REQUEST, "unsupported_encoding", "Only float encoding is supported")
    value = payload.get("input")
    texts = value if isinstance(value, list) else [value]
    if not texts or len(texts) > MAX_BATCH_SIZE or any(not isinstance(text, str) for text in texts):
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            "invalid_input",
            f"input must be a string or an array of at most {MAX_BATCH_SIZE} strings",
        )
    if any(not text.strip() or len(text) > MAX_INPUT_CHARS for text in texts):
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            "invalid_input",
            f"each input must contain 1-{MAX_INPUT_CHARS} characters",
        )
    return texts


def main() -> None:
    # Fail startup if the downloaded model does not match the database contract.
    embed_texts(["启动检查"])
    server = ThreadingHTTPServer((HOST, PORT), EmbeddingHandler)
    print(
        f"Local embedding ready on http://{HOST}:{PORT} model={MODEL_ID} dimensions={EXPECTED_DIMENSIONS}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
