"""使用者名册端点（调研报告 G6）。

**名册不参与鉴权**：伪造一个名字不会获得任何权限，只会让归属记错。
所以读端点用 ``require_read``、写端点用 ``require_console``——
名册是控制台级配置（和 API Key 同一档），而不是靠名字本身做安全边界。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, status

from app.api.auth import require_console, require_read
from app.api.v1.schemas import UserCreateIn, UserListOut, UserOut
from app.core.services import Services, get_services
from app.services.api_key import Caller
from app.services.users import OPERATOR_HEADER

router = APIRouter(prefix="/users", tags=["users"])


def _out(services: Services, record) -> UserOut:  # type: ignore[no-untyped-def]
    return UserOut(
        id=record.id,
        name=record.name,
        note=record.note,
        created_at=record.created_at,
        document_count=services.users.count_documents(record.id),
    )


@router.get("", response_model=UserListOut, summary="使用者名册")
def list_users(
    services: Annotated[Services, Depends(get_services)],
    _: Annotated[Caller, Depends(require_read)],
) -> UserListOut:
    return UserListOut(
        items=[_out(services, item) for item in services.users.list()],
        header=OPERATOR_HEADER,
    )


@router.post(
    "", response_model=UserOut, status_code=status.HTTP_201_CREATED, summary="添加使用者"
)
def create_user(
    payload: UserCreateIn,
    services: Annotated[Services, Depends(get_services)],
    _: Annotated[Caller, Depends(require_console)],
) -> UserOut:
    return _out(services, services.users.create(name=payload.name, note=payload.note))


@router.delete(
    "/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除使用者（其文档保留，归属置空）",
)
def delete_user(
    user_id: str,
    services: Annotated[Services, Depends(get_services)],
    _: Annotated[Caller, Depends(require_console)],
) -> None:
    services.users.delete(user_id)
