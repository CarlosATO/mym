from typing import Any

from fastapi import APIRouter, Depends, Query

from app.financial.sales import get_monthly_net_sales
from app.security.company import AuthorizedCompanyContext, require_company_permission


router = APIRouter(prefix="/financial", tags=["financial"])
CONTROL_FINANCE_VIEW = "analisis_comercial.control_financiero.view"


@router.get("/income-statement/sales-net")
def monthly_net_sales(
    year: int = Query(default=2026, ge=2000, le=2100),
    context: AuthorizedCompanyContext = Depends(
        require_company_permission(CONTROL_FINANCE_VIEW)
    ),
) -> dict[str, Any]:
    return get_monthly_net_sales(context.company_id, year)
