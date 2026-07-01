'use server'

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { revalidatePath } from 'next/cache'
import { getActiveCompanyId } from '@/app/actions/companies'
import type { SalesAnalysisReport } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'

function makeSupabaseClient(cookieStore: any) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet: any[]) {
          try { cookiesToSet.forEach(({ name, value, options }: any) => cookieStore.set(name, value, options)) } catch {}
        },
      },
    }
  )
}

export async function saveSalesAnalysisReport(report: SalesAnalysisReport) {
  try {
    const cookieStore = await cookies()
    const supabase = makeSupabaseClient(cookieStore)
    const { data: { user } } = await supabase.auth.getUser()
    const companyId = await getActiveCompanyId()

    if (!user || !companyId) throw new Error('Sesión inválida o empresa no seleccionada')

    // Eliminar el reporte anterior de la empresa para no acumular reportes históricos innecesarios
    // (solo guardamos el más reciente en este módulo; el historial vive en la memoria del análisis)
    const { data: prevReports } = await supabase
      .schema('adquisiciones')
      .from('sales_analysis_reports')
      .select('id')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
    
    if (prevReports && prevReports.length > 0) {
      await supabase.schema('adquisiciones').from('sales_analysis_reports').delete().eq('company_id', companyId)
    }

    const { data: insertedReport, error: reportErr } = await supabase
      .schema('adquisiciones')
      .from('sales_analysis_reports')
      .insert({
        company_id: companyId,
        created_by: user.id,
        date_from: report.date_from,
        date_to: report.date_to,
        total_sales: report.total_sales,
        total_stock_value: report.total_stock_value,
        target_coverage_weeks: report.target_coverage_weeks,
        diagnostics: report.diagnostics || {},
      })
      .select('id')
      .single()

    if (reportErr || !insertedReport) throw new Error(`Error guardando reporte: ${reportErr?.message}`)

    const reportId = insertedReport.id

    // Insertar items con las métricas extendidas (JSONB) en batches de 300
    const items = report.items.map(item => ({
      report_id: reportId,
      sku: item.sku,
      product_name: item.product_name,
      variant: item.variant,
      supplier: item.supplier || '',
      category: item.category,
      brand: item.brand,
      current_stock: item.current_stock,
      unit_cost: item.unit_cost,
      total_units_sold: item.total_units_sold,
      weekly_average_sales: item.weekly_average_sales,
      suggested_quantity: item.suggested_quantity,
      alert_type: item.alert_type,
      priority: item.priority,
      metrics: item.metrics,
    }))

    const chunkSize = 300
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize)
      const { error: itemsErr } = await supabase
        .schema('adquisiciones')
        .from('sales_analysis_items')
        .insert(chunk)
      if (itemsErr) throw new Error(`Error insertando detalles: ${itemsErr.message}`)
    }

    revalidatePath('/dashboard/adquisiciones')
    return { success: true, reportId }
  } catch (error: any) {
    console.error('Error in saveSalesAnalysisReport:', error)
    return { success: false, error: error.message }
  }
}

export async function getLatestSalesAnalysisReport() {
  try {
    const cookieStore = await cookies()
    const supabase = makeSupabaseClient(cookieStore)
    const companyId = await getActiveCompanyId()
    if (!companyId) return { success: false }

    const { data: report, error } = await supabase
      .schema('adquisiciones')
      .from('sales_analysis_reports')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (error && error.code !== 'PGRST116') throw error
    if (!report) return { success: true, data: null }

    const { data: items, error: itemsErr } = await supabase
      .schema('adquisiciones')
      .from('sales_analysis_items')
      .select('*')
      .eq('report_id', report.id)

    if (itemsErr) throw itemsErr

    return {
      success: true,
      data: { ...report, items: items || [] }
    }
  } catch (error: any) {
    console.error('Error in getLatestSalesAnalysisReport:', error)
    return { success: false, error: error.message }
  }
}
