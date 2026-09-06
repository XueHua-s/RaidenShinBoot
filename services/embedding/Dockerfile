FROM python:3.12-slim

WORKDIR /app

ARG EMBEDDING_PYPI_INDEX_URL=https://pypi.org/simple
ARG PYTORCH_CPU_INDEX_URL=https://download.pytorch.org/whl/cpu

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir --timeout 300 --retries 10 torch==2.9.1+cpu \
    --index-url ${PYTORCH_CPU_INDEX_URL}
COPY services/embedding/requirements.txt ./requirements.txt
RUN set -eu; \
    attempt=1; \
    while [ "$attempt" -le 5 ]; do \
      if pip install --timeout 300 --retries 10 \
        --index-url ${EMBEDDING_PYPI_INDEX_URL} \
        -r requirements.txt; then \
        break; \
      fi; \
      if [ "$attempt" -eq 5 ]; then \
        exit 1; \
      fi; \
      attempt=$((attempt + 1)); \
      echo "Python dependency install failed integrity/network checks; retrying ($attempt/5)."; \
    done; \
    rm -rf /root/.cache/pip

ENV HF_HUB_DISABLE_XET=1 \
    HF_HOME=/models/huggingface

COPY services/embedding/app.py ./app.py
COPY services/embedding/model_cache.py ./model_cache.py

EXPOSE 8080

CMD ["python", "app.py"]
