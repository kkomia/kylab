"""凭据的生成与校验原语（《架构设计 v0.2》§3.2）。

只放"纯函数"级别的密码学动作，不碰存储、不碰请求——密钥怎么存、谁能用哪把钥匙，
那是 ``services/api_key.py`` 与 ``api/deps.py`` 的事（分层纪律 §3.3）。

三个刻意决定：

1. **只存哈希，明文永不落库**。发出去的明文只在创建响应里出现一次，
   之后库里只有摘要。这是凭据类数据的底线。

2. **用 SHA-256 而不是 bcrypt/argon2**。慢哈希是为了对抗"低熵口令被离线爆破"；
   API Key 是 32 字节随机数（256 位熵），爆破空间大到慢哈希没有意义，
   反而每次请求都要付几十毫秒。主流做法也是快速哈希（Dify / RAGFlow 同）。
   **不得**把本模块的 ``hash_token`` 用到用户口令上。

3. **比较用 ``compare_digest``**。虽然我们是"哈希后查库"、并不逐字节比密钥，
   但校验旧格式/调试路径时若出现直接比较，也必须定时安全，免得留下计时侧信道。
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

__all__ = [
    "API_KEY_PREFIX",
    "api_key_prefix",
    "display_prefix",
    "generate_token",
    "hash_token",
    "tokens_equal",
]

#: 明文前缀。**带前缀不是为了好看**：一串无特征的高熵字符串在日志、截图、
#: 粘贴板里没人认得出来，有了前缀才有可能被密钥扫描工具（gitleaks 之类）识别，
#: 也方便用户一眼看出"这是 KYLAB 的钥匙、不是别的服务的"。
API_KEY_PREFIX = "kylab_sk_"

#: 随机部分长度（字节）。32 字节 = 256 位熵。
_TOKEN_BYTES = 32


def generate_token() -> str:
    """生成一把新的 API Key 明文（只在创建时出现一次）。"""
    return API_KEY_PREFIX + secrets.token_urlsafe(_TOKEN_BYTES)


def hash_token(token: str) -> str:
    """凭据摘要。返回值进库，明文不落盘。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def tokens_equal(left: str, right: str) -> bool:
    """定时安全比较（需要直接比明文时用，例如校验控制台令牌）。"""
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def display_prefix(token: str, *, keep: int = 6) -> str:
    """取用于界面展示的前缀（``ab12cd``）。

    这一段会被存进库，好让列表里能分辨"哪把是哪把"。它取自 32 字节随机串，
    留在外面的位数远不足以缩小搜索空间，**不是秘密泄露**。
    """
    body = token[len(API_KEY_PREFIX) :] if token.startswith(API_KEY_PREFIX) else token
    return body[:keep]


def api_key_prefix(token: str) -> str:
    """把明文渲染成给人看的样子（``kylab_sk_ab12…``）。

    只在创建响应里用得到——列表走的是库里存的 ``key_prefix``。
    """
    return f"{API_KEY_PREFIX}{display_prefix(token)}…"
