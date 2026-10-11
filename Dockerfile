FROM python:3.11-slim

WORKDIR /app
COPY pyproject.toml alembic.ini /app/
COPY app /app/app
COPY migrations /app/migrations
RUN pip install --no-cache-dir . \
    # 中文注释：非 root 运行，降低容器逃逸后的破坏面
    && useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/health/live', timeout=3).status==200 else 1)"
# 中文注释：默认不自动迁移；生产用 scripts/migrate.sh 或 docker compose exec api python -m alembic upgrade head
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]
