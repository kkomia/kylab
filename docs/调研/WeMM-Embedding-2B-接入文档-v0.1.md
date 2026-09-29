# WeMM-Embedding-2B 服务接入文档

> 来源：局域网内已部署的本地跨模态 embedding 服务（用户 2026-09-29 提供）。
> 本文件是**原文落档**，供实现与排查时对照；改动它要连同实现一起改，别只改一边。

本地跨模态 embedding 服务，基于 llama.cpp + WeMM-Embedding-2B-GGUF（Q4_K_M）。
输入文本 / 图片 / 视频，输出 **2048 维、已 L2 归一化** 的向量；三种模态共享同一向量空间，
可直接做跨模态相似度计算（文本搜图、以图搜图等）。

## 1. 服务概览

| 项目 | 值 |
|---|---|
| 调用地址 | `http://127.0.0.1:8234`（监听 0.0.0.0，局域网可用本机 IP 访问） |
| 文本接口 | `POST /v1/embeddings`（OpenAI 兼容） |
| 图片/视频接口 | `POST /embedding`（原生）或 `POST /v1/embeddings`（OpenAI 兼容） |
| 辅助接口 | `GET /props`（获取 media_marker）、`GET /health` |
| 向量维度 | 2048（可用 Matryoshka 截断到 1024/512/256/128/64） |
| 归一化 | 已 L2 归一化，余弦相似度 = 点积 |

调用链路：你的项目 → `:8234` 代理（systemd 服务 `wemm-proxy`）→ 容器 `wemm-embedding`（GPU）。

**不要直连 18234 端口**（容器内部端口，绕过代理会导致空闲卸载失效）。

## 2. 接入前必读

1. **冷启动**：服务空闲 30 分钟会自动卸载模型（释放显存）。之后第一个请求会触发加载，
   需要 **约 10 秒**。客户端超时建议 ≥ 30 秒；媒体（视频）请求建议 ≥ 120 秒。
2. **502 表示暂时不可用**，响应体为 `{"error": "..."}`，按指数退避重试即可（见 §6）。
3. **不要手动拼接 `<embedding>` 标记**：服务端会自动追加该特殊 token，手动加会污染输入。
4. **只使用 embedding 接口**：本模型为 embedding 专用，不要调用 `/completion` 等生成接口。
5. **并发**：总吞吐封顶约 33 请求/秒（约 2900 token/秒，详见 §7 实测）。
   批量场景请用"一个请求传数组"，不要开大量并发线程——并发只会增加排队延迟，不提高吞吐。
6. **media_marker 会变**：每次服务重启（含冷启动）`/props` 的 `media_marker` 都会变化，
   客户端不要硬编码，每次媒体请求前获取（开销极小）。

## 3. 文本 embedding

```bash
curl http://127.0.0.1:8234/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"WeMM-Embedding-2B-Q4_K_M.gguf","input":"多模态检索测试"}'
```

批量（推荐，一次最多可以传几十条，吞吐最优）：

```bash
curl http://127.0.0.1:8234/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"WeMM-Embedding-2B-Q4_K_M.gguf","input":["第一条文本","第二条文本"]}'
```

请求字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | 固定填 `WeMM-Embedding-2B-Q4_K_M.gguf` |
| `input` | string \| string[] | 单条或批量文本 |

响应结构（真实返回，2048 维数组已截断展示）：

```json
{
  "model": "WeMM-Embedding-2B-Q4_K_M.gguf",
  "object": "list",
  "usage": {"prompt_tokens": 3, "total_tokens": 3},
  "data": [
    {"object": "embedding", "index": 0, "embedding": [0.0613, -0.0188, 0.1036, "...(共2048个float)"]}
  ]
}
```

`data` 数组的 `index` 与输入顺序对应。

## 4. 图片 / 视频 embedding

多模态走"媒体标记"协议，步骤固定为三步：

1. `GET /props` → 取 `media_marker`（形如 `<__media_xxxx__>`，每进程随机）
2. 将媒体文件字节做 **base64**，与 `prompt_string` 一起构成 prompt 对象
3. POST 该对象，取回向量

**原生端点**（推荐，官方示例脚本默认走这个）：

```json
POST /embedding
{
  "content": {
    "prompt_string": "可选文字描述\n<__media_xxxx__>",
    "multimodal_data": ["<文件字节的base64>"]
  }
}
```

响应：`[{"embedding": [[...2048维...]]}]`

**OpenAI 兼容端点**（适合已有 OpenAI SDK 的项目）：

```json
POST /v1/embeddings
{
  "model": "WeMM-Embedding-2B-Q4_K_M.gguf",
  "input": {"prompt_string": "<__media_xxxx__>", "multimodal_data": ["<base64>"]},
  "encoding_format": "float"
}
```

响应与 §3 相同（`data[0].embedding`）。

> **大坑**：不要用旧式 `image_data` + `[img-N]` 字段——当前 llama.cpp 会把它当纯文本
> **静默忽略**，不报错但图片根本没生效。必须用上面的 `prompt_string` + `multimodal_data`。
>
> 可选 `caption`：把描述文字放在 marker 前面、用 `\n` 分隔，可引导嵌入语义。
>
> 视频仅需把视频文件（mp4 等）base64 传入即可，服务端容器内置 ffmpeg 解码。

## 5. 可直接复用的 Python 客户端 + 跨模态检索示例

标准库实现（无第三方依赖，可直接拷进项目）：

```python
import base64
import json
import urllib.request

BASE = "http://127.0.0.1:8234"
MODEL = "WeMM-Embedding-2B-Q4_K_M.gguf"


def _post(path, payload, timeout=60):
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error


def embed_text(texts):
    """文本 → 向量列表。texts 可为 str 或 list[str]。"""
    if isinstance(texts, str):
        texts = [texts]
    out = _post("/v1/embeddings", {"model": MODEL, "input": texts})
    data = sorted(out["data"], key=lambda item: item["index"])
    return [item["embedding"] for item in data]


def embed_media(path):
    """图片/视频文件 → 向量。"""
    with urllib.request.urlopen(BASE + "/props", timeout=30) as response:
        marker = json.loads(response.read())["media_marker"]
    media_b64 = base64.b64encode(open(path, "rb").read()).decode()
    out = _post(
        "/embedding",
        {"content": {"prompt_string": marker, "multimodal_data": [media_b64]}},
        timeout=300,
    )
    embedding = out[0]["embedding"]
    return embedding[0] if embedding and isinstance(embedding[0], list) else embedding


def cosine(a, b):
    """已 L2 归一化，点积即余弦相似度。"""
    return sum(x * y for x, y in zip(a, b))


if __name__ == "__main__":
    # 跨模态检索：文本查询 vs 图库
    query_vec = embed_text("一只在草地上奔跑的狗")[0]
    for image_path in ["dog.jpg", "car.jpg", "cat.jpg"]:
        score = cosine(query_vec, embed_media(image_path))
        print(f"{image_path}: {score:.4f}")
```

若项目已用 `requests`，把 `_post` 换成 `requests.post(...).json()` 即可，其余不变。
官方完整示例（含维度截断、命令行参数）在 `~/models/wemm/llama_cpp_multimodal_embedding.py`。

## 6. 错误与超时处理

| 现象 | 原因 | 处理 |
|---|---|---|
| 首个请求耗时 ~10s | 空闲卸载后冷启动（正常） | 客户端超时设 ≥30s；或加预热请求 |
| `502` + JSON error | 后端短暂不可用 | 退避重试（可安全重试，embedding 无副作用） |
| 连接被拒 | 代理服务未运行 | `systemctl --user status wemm-proxy` 检查 |
| 媒体请求报 marker 相关错误 | 服务重启导致 marker 失效 | 重新 `GET /props` 获取 |

重试封装示例：

```python
import time

def with_retry(fn, attempts=3, delay=5):
    for i in range(attempts):
        try:
            return fn()
        except RuntimeError as error:
            if "502" in str(error) and i < attempts - 1:
                time.sleep(delay * (i + 1))
                continue
            raise
```

## 7. 性能实测（RTX 3070 Laptop，Q4_K_M）

| 场景 | 吞吐 | 延迟参考 |
|---|---:|---:|
| 短文本（~10 token） | 74 请求/秒 | 13ms |
| 长文本（~88 token）串行 | 31 请求/秒 | 32ms |
| 长文本 并发 4 / 8 | ~33 请求/秒（封顶） | 121 / 228ms |
| 48 条长文本打包单请求 | 等价 32 条/秒 | 整批 1.49s |
| 512×512 图片 | ~5 张/秒 | 204ms |

接入建议：文本批量用数组输入、单并发；图片视频串行或低并发。总吞吐瓶颈在 GPU
（约 2900 token/秒），加并发不会变快。

## 8. 运维速查

```bash
systemctl --user status wemm-proxy      # 代理状态（正常应为 active）
systemctl --user restart wemm-proxy     # 重启代理
journalctl --user -u wemm-proxy -f      # 代理日志（启动/卸载/报错）
docker logs -f wemm-embedding           # llama-server 日志

curl -s http://127.0.0.1:8234/health    # 健康检查（注意：会触发冷启动）
```

- 空闲卸载时间：改 `~/.config/systemd/user/wemm-proxy.service` 的
  `WEMM_IDLE_SECONDS=1800`，然后 `systemctl --user daemon-reload && systemctl --user restart wemm-proxy`
- 开机自启：容器 `restart=always` + 代理服务 `enabled`（含 linger，登录前即启动）

### 文件清单

| 文件 | 用途 |
|---|---|
| `~/models/wemm/WeMM-Embedding-2B-Q4_K_M.gguf` | 主模型（1.56GB） |
| `~/models/wemm/mmproj-WeMM-Embedding-2B-BF16.gguf` | 视觉投影（图片/视频必需，671MB） |
| `~/models/wemm/wemm_proxy.py` | 按需启停代理 |
| `~/models/wemm/llama_cpp_multimodal_embedding.py` | 官方多模态示例客户端 |
| `~/models/wemm/bench_embedding.py` | 吞吐基准脚本 |

## 9. 已知限制

- 不支持音频输入。
- 固定输出 2048 维；更小维度用 Matryoshka 截断（取前 N 维后重新归一化，官方客户端已实现）。
- 图片检索精度若异常，可在容器启动参数加 `--image-min-tokens 1024`（见官方模型卡）。
