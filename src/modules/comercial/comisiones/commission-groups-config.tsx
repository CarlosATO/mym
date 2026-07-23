'use client'

import { useEffect, useState } from 'react'
import { LoaderCircle, PackagePlus, Search, Trash2 } from 'lucide-react'
import { searchCommissionProducts, updateCommissionGroupProducts, upsertCommissionGroup, type CommissionGroup } from '@/app/actions/comercial/commissions'

type Product = { id: string; sku: string; description: string; supplier_id: string | null; supplier_name: string | null }

export function CommissionGroupsConfig({ groups, onSaved, setError }: { groups: CommissionGroup[]; onSaved: () => Promise<void>; setError: (message: string) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)

  const search = async () => {
    if (query.trim().length < 2) { setResults([]); return }
    setSearching(true)
    try { setResults(await searchCommissionProducts(query)) } catch (error) { setError(error instanceof Error ? error.message : 'No se pudieron buscar productos') } finally { setSearching(false) }
  }
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (query.trim().length < 2) { setResults([]); return }
      setSearching(true)
      void searchCommissionProducts(query).then(setResults).catch(error => setError(error instanceof Error ? error.message : 'No se pudieron buscar productos')).finally(() => setSearching(false))
    }, 400)
    return () => window.clearTimeout(timeout)
  }, [query, setError])
  const addProduct = (product: Product) => setProducts(current => current.some(item => item.id === product.id) ? current : [...current, product])
  const removeProduct = (id: string) => setProducts(current => current.filter(item => item.id !== id))
  const save = async () => {
    if (!name.trim()) { setError('Ingresa un nombre para el grupo.'); return }
    if (!products.length) { setError('Selecciona al menos un producto para el grupo.'); return }
    setSaving(true)
    try {
      const group = await upsertCommissionGroup({ code: name.trim().toUpperCase().replace(/\s+/g, '-'), name, description, supplier_id: null, parent_supplier_id: null, is_active: true })
      await updateCommissionGroupProducts(group.id, products.map(product => product.id))
      await onSaved()
      setName(''); setDescription(''); setQuery(''); setResults([]); setProducts([])
    } catch (error) { setError(error instanceof Error ? error.message : 'No se pudo guardar el grupo') } finally { setSaving(false) }
  }

  return <section className="w-full space-y-5">
    <header><h3 className="text-base font-semibold text-theme-text">Grupos / Campañas</h3><p className="mt-1 text-sm text-theme-text-muted">Crea conjuntos reutilizables de productos para campañas o condiciones especiales. La regla define vigencia, vendedor y porcentaje.</p></header>
    <section className="rounded-xl border border-theme-border bg-theme-bg/30 p-4"><h4 className="font-semibold text-theme-text">Datos del grupo</h4><div className="mt-4 grid gap-3 md:grid-cols-2"><label className="text-sm font-medium text-theme-text">Nombre del grupo<input value={name} onChange={event => setName(event.target.value)} placeholder="Ej. Promoción invierno" className="mt-1" /></label><label className="text-sm font-medium text-theme-text">Descripción opcional<input value={description} onChange={event => setDescription(event.target.value)} placeholder="Explica qué productos reúne" className="mt-1" /></label></div></section>
    <section className="rounded-xl border border-theme-border bg-theme-bg/30 p-4"><div><h4 className="font-semibold text-theme-text">Buscar productos</h4><p className="mt-1 text-sm text-theme-text-muted">Busca por SKU o descripción y agrega los productos que formarán parte del grupo.</p></div><div className="mt-4 flex flex-col gap-2 sm:flex-row"><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search() } }} placeholder="Buscar por SKU o descripción" /><button type="button" onClick={() => void search()} disabled={searching || query.trim().length < 2} className="btn-secondary shrink-0">{searching ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}Buscar</button></div><ProductTable products={results} emptyMessage={query.trim().length < 2 ? 'Escribe al menos 2 caracteres para buscar productos.' : 'No se encontraron productos.'} actionLabel="Agregar" onAction={addProduct} selectedIds={new Set(products.map(product => product.id))} /></section>
    <section className="rounded-xl border border-theme-border bg-theme-bg/30 p-4"><div className="flex items-center justify-between gap-3"><div><h4 className="font-semibold text-theme-text">Productos seleccionados</h4><p className="mt-1 text-sm text-theme-text-muted">{products.length} {products.length === 1 ? 'producto seleccionado' : 'productos seleccionados'}</p></div><span className="rounded-full bg-theme-accent-muted px-2.5 py-1 text-xs font-semibold text-theme-text">{products.length}</span></div><ProductTable products={products} emptyMessage="Todavía no has seleccionado productos para este grupo." actionLabel="Quitar" onAction={product => removeProduct(product.id)} destructive /></section>
    <div className="flex justify-end"><button type="button" onClick={() => void save()} disabled={saving || !name.trim() || !products.length} className="btn-primary">{saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <PackagePlus className="h-3.5 w-3.5" />}Guardar grupo</button></div>
    <section className="rounded-xl border border-theme-border bg-theme-bg/30 p-4"><div className="mb-3"><h4 className="font-semibold text-theme-text">Grupos existentes</h4><p className="mt-1 text-sm text-theme-text-muted">Los grupos activos pueden usarse al crear condiciones de comisión.</p></div>{groups.length ? <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-sm"><thead><tr><th>Grupo</th><th>Descripción</th><th>Estado</th></tr></thead><tbody>{groups.map(group => <tr key={group.id}><td><div className="font-medium">{group.name}</div><div className="text-xs text-theme-text-muted">{group.code}</div></td><td className="text-theme-text-muted">{group.description || 'Sin descripción'}</td><td><span className={group.is_active ? 'rounded-full bg-theme-accent-muted px-2 py-1 text-xs font-semibold' : 'rounded-full border border-theme-border px-2 py-1 text-xs text-theme-text-muted'}>{group.is_active ? 'Activo' : 'Inactivo'}</span></td></tr>)}</tbody></table></div> : <Empty message="No hay grupos creados todavía." />}</section>
  </section>
}

function ProductTable({ products, emptyMessage, actionLabel, onAction, selectedIds, destructive = false }: { products: Product[]; emptyMessage: string; actionLabel: string; onAction: (product: Product) => void; selectedIds?: Set<string>; destructive?: boolean }) { return <div className="mt-4 overflow-x-auto rounded-lg border border-theme-border"><table className="w-full min-w-[680px] text-sm"><thead><tr><th>SKU</th><th>Producto</th><th>Proveedor</th><th className="w-28">Acción</th></tr></thead><tbody>{products.map(product => <tr key={product.id}><td className="font-mono text-xs">{product.sku}</td><td>{product.description}</td><td className="text-theme-text-muted">{product.supplier_name || 'Sin proveedor asociado'}</td><td>{selectedIds?.has(product.id) ? <span className="text-xs font-medium text-theme-text-muted">Agregado</span> : <button type="button" onClick={() => onAction(product)} className="btn-secondary">{destructive && <Trash2 className="h-3.5 w-3.5" />}{actionLabel}</button>}</td></tr>)}</tbody></table>{!products.length && <Empty message={emptyMessage} />}</div> }
function Empty({ message }: { message: string }) { return <div className="p-6 text-center text-sm text-theme-text-muted">{message}</div> }
