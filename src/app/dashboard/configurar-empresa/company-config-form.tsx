'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateActiveCompanyData, type Company } from '@/app/actions/companies'
import { toast } from 'sonner'
import * as LucideIcons from 'lucide-react'

interface CompanyConfigFormProps {
  company: Company
}

export function CompanyConfigForm({ company }: CompanyConfigFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  
  // State for form fields
  const [businessName, setBusinessName] = useState(company.business_name || '')
  const [tradeName, setTradeName] = useState(company.trade_name || '')
  const [rut, setRut] = useState(company.rut || '')
  const [giro, setGiro] = useState(company.giro || '')
  const [address, setAddress] = useState(company.address || '')
  const [comuna, setComuna] = useState(company.comuna || '')
  const [city, setCity] = useState(company.city || '')
  const [region, setRegion] = useState(company.region || '')
  const [phone, setPhone] = useState(company.phone || '')
  const [email, setEmail] = useState(company.email || '')
  const [purchaseEmail, setPurchaseEmail] = useState(company.purchase_email || '')
  const [financeEmail, setFinanceEmail] = useState(company.finance_email || '')
  const [website, setWebsite] = useState(company.website || '')
  const [logoUrl, setLogoUrl] = useState(company.logo_url || '')
  const [adminContactName, setAdminContactName] = useState(company.admin_contact_name || '')
  const [observations, setObservations] = useState(company.observations || '')
  const [isActive, setIsActive] = useState(company.is_active !== false)

  // Future options state
  const [documentFooter, setDocumentFooter] = useState(company.document_footer || '')
  const [purchaseTerms, setPurchaseTerms] = useState(company.purchase_terms || '')
  const [legalText, setLegalText] = useState(company.legal_text || '')
  const [defaultPoPrefix, setDefaultPoPrefix] = useState(company.default_po_prefix || 'OC')
  const [defaultCurrency, setDefaultCurrency] = useState(company.default_currency || 'CLP')
  const [defaultTaxRate, setDefaultTaxRate] = useState(company.default_tax_rate !== null ? company.default_tax_rate : 19)
  const [defaultPaymentDays, setDefaultPaymentDays] = useState(company.default_payment_days !== null ? company.default_payment_days : 30)

  // RUT formatting helper
  const handleRutChange = (val: string) => {
    // Basic filter characters
    const cleaned = val.replace(/[^0-9kK]/g, '')
    setRut(cleaned)
  }

  const handleRutBlur = () => {
    if (!rut) return
    const cleaned = rut.replace(/[^0-9kK]/g, '')
    if (cleaned.length >= 2) {
      const dv = cleaned.slice(-1).toUpperCase()
      const body = cleaned.slice(0, -1)
      const formatted = `${body.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dv}`
      setRut(formatted)
    }
  }

  // Validate RUT format
  const validateRut = (rutStr: string): boolean => {
    if (!rutStr) return true // Optional if empty
    const clean = rutStr.replace(/[^0-9kK]/g, '')
    if (clean.length < 2) return false
    
    const body = clean.slice(0, -1)
    const dv = clean.slice(-1).toUpperCase()
    
    let sum = 0
    let multiplier = 2
    for (let i = body.length - 1; i >= 0; i--) {
      sum += parseInt(body[i]) * multiplier
      multiplier = multiplier === 7 ? 2 : multiplier + 1
    }
    
    const expectedDvVal = 11 - (sum % 11)
    let expectedDv = expectedDvVal === 11 ? '0' : expectedDvVal === 10 ? 'K' : expectedDvVal.toString()
    
    return dv === expectedDv
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!businessName.trim()) {
      toast.error('La Razón Social es requerida')
      return
    }

    if (rut && !validateRut(rut)) {
      toast.error('El RUT ingresado no es válido')
      return
    }

    setLoading(true)
    
    try {
      const res = await updateActiveCompanyData({
        business_name: businessName,
        trade_name: tradeName || null,
        rut: rut || null,
        giro: giro || null,
        address: address || null,
        comuna: comuna || null,
        city: city || null,
        region: region || null,
        phone: phone || null,
        email: email || null,
        purchase_email: purchaseEmail || null,
        finance_email: financeEmail || null,
        website: website || null,
        logo_url: logoUrl || null,
        admin_contact_name: adminContactName || null,
        observations: observations || null,
        is_active: isActive,
        document_footer: documentFooter || null,
        purchase_terms: purchaseTerms || null,
        legal_text: legalText || null,
        default_po_prefix: defaultPoPrefix || null,
        default_currency: defaultCurrency || null,
        default_tax_rate: Number(defaultTaxRate),
        default_payment_days: Number(defaultPaymentDays),
      })

      if (res.success) {
        toast.success('Datos de la empresa actualizados correctamente')
        router.refresh()
        router.push('/dashboard')
      } else {
        toast.error(res.error || 'Error al actualizar datos')
      }
    } catch (err) {
      console.error(err)
      toast.error('Error inesperado al guardar')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* SECTION 1: Identificación y Datos Generales */}
      <div className="rounded-2xl border border-theme-border bg-theme-surface/60 backdrop-blur-md p-6 space-y-6">
        <div className="flex items-center gap-2 border-b border-theme-border/60 pb-3">
          <LucideIcons.Building className="h-5 w-5 text-theme-accent" />
          <h2 className="text-sm font-bold text-theme-text uppercase tracking-wider">Identificación de la Empresa</h2>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Razón Social *</label>
            <input
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. Distribuidora MYM S.A."
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Nombre de Fantasía</label>
            <input
              type="text"
              value={tradeName}
              onChange={(e) => setTradeName(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. DISTRIBUIDORA MYM"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">RUT</label>
            <input
              type="text"
              value={rut}
              onChange={(e) => handleRutChange(e.target.value)}
              onBlur={handleRutBlur}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. 76.123.456-7"
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs font-bold text-theme-text-muted">Giro Comercial</label>
            <input
              type="text"
              value={giro}
              onChange={(e) => setGiro(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. Venta al por mayor de artículos de ferretería"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Estado</label>
            <select
              value={isActive ? 'true' : 'false'}
              onChange={(e) => setIsActive(e.target.value === 'true')}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-theme-surface text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
            >
              <option value="true">Activa / Operativa</option>
              <option value="false">Inactiva</option>
            </select>
          </div>
        </div>
      </div>

      {/* SECTION 2: Ubicación y Contactos */}
      <div className="rounded-2xl border border-theme-border bg-theme-surface/60 backdrop-blur-md p-6 space-y-6">
        <div className="flex items-center gap-2 border-b border-theme-border/60 pb-3">
          <LucideIcons.MapPin className="h-5 w-5 text-theme-accent" />
          <h2 className="text-sm font-bold text-theme-text uppercase tracking-wider">Contacto y Localización</h2>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs font-bold text-theme-text-muted">Dirección</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. Av. Vitacura 1234, Of. 501"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Comuna</label>
            <input
              type="text"
              value={comuna}
              onChange={(e) => setComuna(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. Vitacura"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Ciudad</label>
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. Santiago"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Región</label>
            <input
              type="text"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. Metropolitana"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Teléfono</label>
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. +56 2 1234 5678"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Email Principal</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. contacto@empresa.cl"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Email Compras</label>
            <input
              type="email"
              value={purchaseEmail}
              onChange={(e) => setPurchaseEmail(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. adquisiciones@empresa.cl"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Email Finanzas</label>
            <input
              type="email"
              value={financeEmail}
              onChange={(e) => setFinanceEmail(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. facturas@empresa.cl"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Sitio Web</label>
            <input
              type="text"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. www.empresa.cl"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Contacto Administrativo</label>
            <input
              type="text"
              value={adminContactName}
              onChange={(e) => setAdminContactName(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. Juan Pérez"
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs font-bold text-theme-text-muted">Ruta o URL del Logo</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                className="flex-1 h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
                placeholder="Ej. /logo-transparent.png"
              />
              {logoUrl && (
                <div className="w-10 h-10 rounded-xl bg-white/5 border border-theme-border flex items-center justify-center p-1 shrink-0">
                  <img src={logoUrl} alt="Preview" className="w-8 h-8 object-contain" onError={(e) => (e.currentTarget.style.display = 'none')} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 3: Parámetros del PDF y Adquisiciones */}
      <div className="rounded-2xl border border-theme-border bg-theme-surface/60 backdrop-blur-md p-6 space-y-6">
        <div className="flex items-center gap-2 border-b border-theme-border/60 pb-3">
          <LucideIcons.FileText className="h-5 w-5 text-theme-accent" />
          <h2 className="text-sm font-bold text-theme-text uppercase tracking-wider">Parámetros Operativos e Impresión (PDF)</h2>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Prefijo de Orden de Compra</label>
            <input
              type="text"
              value={defaultPoPrefix}
              onChange={(e) => setDefaultPoPrefix(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Por defecto: OC"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-theme-text-muted">Moneda Predeterminada</label>
            <input
              type="text"
              value={defaultCurrency}
              onChange={(e) => setDefaultCurrency(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
              placeholder="Ej. CLP"
            />
          </div>

          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-theme-text-muted">Tasa IVA %</label>
                <input
                  type="number"
                  value={defaultTaxRate}
                  onChange={(e) => setDefaultTaxRate(Number(e.target.value))}
                  className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
                  min="0"
                  max="100"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-theme-text-muted">Días Pago Def.</label>
                <input
                  type="number"
                  value={defaultPaymentDays}
                  onChange={(e) => setDefaultPaymentDays(Number(e.target.value))}
                  className="w-full h-10 px-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors"
                  min="0"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <label className="text-xs font-bold text-theme-text-muted">Pie de Página de Documento PDF (Legal / Sucursales)</label>
            <textarea
              value={documentFooter}
              onChange={(e) => setDocumentFooter(e.target.value)}
              rows={2}
              className="w-full p-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors resize-y"
              placeholder="Detalle de sucursales, datos bancarios o información corporativa fija..."
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <label className="text-xs font-bold text-theme-text-muted">Condiciones Generales de Compra</label>
            <textarea
              value={purchaseTerms}
              onChange={(e) => setPurchaseTerms(e.target.value)}
              rows={3}
              className="w-full p-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors resize-y"
              placeholder="Términos comerciales estándar de la OC, plazos de facturación, condiciones de entrega..."
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <label className="text-xs font-bold text-theme-text-muted">Texto Legal Adicional</label>
            <textarea
              value={legalText}
              onChange={(e) => setLegalText(e.target.value)}
              rows={2}
              className="w-full p-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors resize-y"
              placeholder="Ej: La aceptación de esta orden implica la adhesión incondicional a las normas legales chilenas..."
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <label className="text-xs font-bold text-theme-text-muted">Observaciones / Notas Internas</label>
            <textarea
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              rows={2}
              className="w-full p-3 rounded-xl border border-theme-border bg-white/5 text-sm text-theme-text focus:border-theme-accent/50 outline-none transition-colors resize-y"
              placeholder="Notas generales de uso administrativo..."
            />
          </div>
        </div>
      </div>

      {/* SUBMIT BUTTON */}
      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={() => router.push('/dashboard')}
          className="h-11 px-6 rounded-xl border border-theme-border text-sm font-semibold text-theme-text-muted hover:bg-white/5 transition-colors"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={loading}
          className="h-11 px-8 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold shadow-lg shadow-theme-accent/20 transition-all flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <LucideIcons.Loader2 className="h-4 w-4 animate-spin" />
              Guardando...
            </>
          ) : (
            <>
              <LucideIcons.Save className="h-4 w-4" />
              Guardar Cambios
            </>
          )}
        </button>
      </div>
    </form>
  )
}
