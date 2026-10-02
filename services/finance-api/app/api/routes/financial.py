from typing import Any

from fastapi import APIRouter, Depends, Query

from app.financial.cogs import get_monthly_cogs
from app.financial.expenses import get_monthly_expenses
from app.financial.personnel import get_monthly_personnel
from app.financial.sales import (
    get_monthly_net_sales,
    get_sales_net_by_family,
    get_sales_net_detail,
    get_sales_net_document_lines,
)
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


@router.get("/income-statement/cogs")
def monthly_cogs(
    year: int = Query(default=2026, ge=2000, le=2100),
    context: AuthorizedCompanyContext = Depends(
        require_company_permission(CONTROL_FINANCE_VIEW)
    ),
) -> dict[str, Any]:
    return get_monthly_cogs(context.company_id, year)


@router.get("/income-statement/personnel")
def monthly_personnel(
    year: int = Query(default=2026, ge=2000, le=2100),
    context: AuthorizedCompanyContext = Depends(
        require_company_permission(CONTROL_FINANCE_VIEW)
    ),
) -> dict[str, Any]:
    return get_monthly_personnel(context.company_id, year)


@router.get("/income-statement/expenses")
def monthly_expenses(
    year: int = Query(default=2026, ge=2000, le=2100),
    context: AuthorizedCompanyContext = Depends(
        require_company_permission(CONTROL_FINANCE_VIEW)
    ),
) -> dict[str, Any]:
    return get_monthly_expenses(context.company_id, year)


@router.get("/income-statement/sales-net/detail")
def sales_net_detail(
    year: int = Query(default=2026, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    family_key: str | None = Query(default=None, min_length=1, max_length=200),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=500),
    context: AuthorizedCompanyContext = Depends(
        require_company_permission(CONTROL_FINANCE_VIEW)
    ),
) -> dict[str, Any]:
    return get_sales_net_detail(context.company_id, year, month, family_key, page, page_size)


@router.get("/income-statement/sales-net/document/{document_id}/lines")
def sales_net_document_lines(
    document_id: int,
    year: int = Query(default=2026, ge=2000, le=2100),
    provider_key: str | None = Query(default=None, max_length=200),
    family_key: str | None = Query(default=None, max_length=200),
    context: AuthorizedCompanyContext = Depends(
        require_company_permission(CONTROL_FINANCE_VIEW)
    ),
) -> dict[str, Any]:
    return get_sales_net_document_lines(
        context.company_id,
        year,
        document_id,
        provider_key,
        family_key,
    )


@router.get("/income-statement/sales-net/by-family")
def sales_net_by_family(
    year: int = Query(default=2026, ge=2000, le=2100),
    context: AuthorizedCompanyContext = Depends(
        require_company_permission(CONTROL_FINANCE_VIEW)
    ),
) -> dict[str, Any]:
    return get_sales_net_by_family(context.company_id, year)
