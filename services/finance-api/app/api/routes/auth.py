from fastapi import APIRouter, Depends

from app.security.auth import AuthenticatedUser, get_current_user
from app.security.company import (
    AuthorizedCompanyContext,
    get_authorized_company_context,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me")
def me(user: AuthenticatedUser = Depends(get_current_user)) -> dict[str, str]:
    return {"user_id": user.user_id}


@router.get("/context")
def context(
    authorized_context: AuthorizedCompanyContext = Depends(
        get_authorized_company_context
    ),
) -> dict[str, str]:
    return {
        "user_id": authorized_context.user_id,
        "company_id": str(authorized_context.company_id),
    }
