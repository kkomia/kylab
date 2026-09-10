# 后端镜像（M7 / T7.1）。
#
# 两阶段构建：构建期需要编译工具链（部分依赖带原生扩展），运行期不需要——
# 把它们留在运行镜像里会让攻击面与体积都白白变大。
FROM python:3.12-slim AS builder

# uv 装依赖比 pip 快一个数量级，也是本项目开发期用的工具，口径一致
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# 先只拷依赖清单再装：源码改动不会让依赖层失效，重复构建能命中缓存
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-install-project --no-dev

COPY app ./app
RUN uv sync --no-dev


FROM python:3.12-slim AS runtime

# **不设 PYTHONUNBUFFERED 之外的优化**：日志要实时出来，
# 否则容器里排查问题只能看到缓冲后的残片
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

# 非 root 运行。容器里以 root 跑一个 Web 服务没有任何好处，
# 而一旦被拿下就是宿主级权限
RUN useradd --create-home --uid 10001 kylab

WORKDIR /app
COPY --from=builder --chown=kylab:kylab /app /app

# 数据目录（SQLite + 向量分区 + 对象存储）挂在这里，见 compose 的卷
RUN mkdir -p /data && chown kylab:kylab /data
VOLUME ["/data"]

USER kylab
EXPOSE 8000

# 健康检查打 /api/v1/health：它不鉴权（探针不该带凭据），
# 且会真的探一下存储是否可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
