import sys

file_path = r'c:\Users\mympr\OneDrive\Desktop\PetGrup\mym\src\modules\logistica\productos\products-panel.tsx'
content = open(file_path, 'r', encoding='utf-8').read()

# 1. Rename component
content = content.replace('export function CatalogPanel() {', 'export function ProductsPanel() {')

# 2. Hide "Nuevo" button
btn_nuevo = '''            {/* Nuevo */}
            <button onClick={() => { resetForm(); setShowForm(true) }} className="h-11 px-4 md:px-5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-all shadow-lg shadow-theme-accent/20 flex items-center justify-center gap-2 ml-auto md:ml-0">
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Nuevo</span>
            </button>'''
content = content.replace(btn_nuevo, '')

# 3. Hide "Importar Excel"
label_importar = '''                <label className="w-full text-left px-3 py-2.5 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors flex items-center gap-2 cursor-pointer">
                  <Upload className="w-4 h-4" /> Importar Excel
                  <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFileUpload} className="hidden" />
                </label>'''
content = content.replace(label_importar, '')

# 4. Remove actions header in table
th_acciones = '<th className="text-right py-3 px-4 font-medium">Acciones</th>'
content = content.replace(th_acciones, '')

# 5. Remove actions cell in table
td_acciones = '''                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={e => { e.stopPropagation(); openEdit(p) }} className="text-theme-text-muted hover:text-theme-text p-1 rounded transition-colors" title="Editar">
                        <svg className="w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                      </button>
                      <button onClick={e => { e.stopPropagation(); handleDeactivate(p) }} className={`text-xs font-semibold ${p.is_active ? 'text-red-500 hover:text-red-400' : 'text-theme-accent hover:text-theme-accent-hover'}`} title={p.is_active ? 'Desactivar producto' : 'Activar producto'}>
                        {p.is_active ? 'Desactivar' : 'Activar'}
                      </button>
                    </div>
                  </td>'''
content = content.replace(td_acciones, '')

# 6. Remove edit/deactivate buttons in grid view
card_actions = '''                  <div className="flex items-center gap-2 pt-1 border-t border-gray-200/80 dark:border-theme-border">
                    <button onClick={e => { e.stopPropagation(); openEdit(p) }} className="text-xs text-theme-text-muted/70 hover:text-theme-text-accent">Editar</button>
                    <button onClick={e => { e.stopPropagation(); handleDeactivate(p) }} className={`text-xs ${p.is_active ? 'text-red-500/80 hover:text-red-500' : 'text-theme-text-muted/70 hover:text-theme-text-accent'}`}>{p.is_active ? 'Desactivar' : 'Activar'}</button>
                  </div>'''
content = content.replace(card_actions, '')

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("UI stripped")
