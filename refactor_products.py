import sys
import re

file_path = r'c:\Users\mympr\OneDrive\Desktop\PetGrup\mym\src\modules\logistica\productos\products-panel.tsx'
content = open(file_path, 'r', encoding='utf-8').read()

# Change component name
content = content.replace('export function CatalogPanel() {', 'export function ProductsPanel() {')

# Remove import functions that allow edits
imports_to_remove = ['createProduct', 'updateProduct', 'deactivateProduct', 'importProducts']
for imp in imports_to_remove:
    content = content.replace(f', {imp}', '')

# We will just disable the buttons by hiding them, or regex out the buttons
content = content.replace('onClick={handleImportConfirm}', 'onClick={undefined}')

# Hide "Nuevo" button:
# <button onClick={() => { resetForm(); setShowForm(true) }} className="..."><Plus className="w-4 h-4" /><span className="hidden sm:inline">Nuevo</span></button>
content = re.sub(r'<button onClick=\{[^}]*setShowForm\(true\)[^>]*>.*?</button>', '', content, flags=re.DOTALL)

# Hide Import/Export options that modify: "Importar Excel"
content = re.sub(r'<label[^>]*>\s*<Upload[^>]*/>\s*Importar Excel.*?</label>', '', content, flags=re.DOTALL)

# Remove Acciones column header
content = content.replace('<th className="text-right py-3 px-4 font-medium">Acciones</th>', '')

# Remove Acciones cell in table:
# <td className="py-3 px-4 text-right">
# ...
# </td>
# It's the last td in the row, we can just replace the whole block or regex it.
content = re.sub(r'<td className="py-3 px-4 text-right">.*?</td>', '', content, flags=re.DOTALL)

# Remove "Editar" and "Desactivar" buttons in cards view:
# <div className="flex items-center gap-2 pt-1 border-t border-gray-200/80 dark:border-theme-border">
#   <button onClick={e => { e.stopPropagation(); openEdit(p) }} ...>Editar</button>
#   <button onClick={e => { e.stopPropagation(); handleDeactivate(p) }} ...>...</button>
# </div>
content = re.sub(r'<div className="flex items-center gap-2 pt-1 border-t border-gray-200/80 dark:border-theme-border">\s*<button[^>]*>Editar</button>\s*<button[^>]*>.*?</button>\s*</div>', '', content, flags=re.DOTALL)

# Update title in module ribbon if there is any? No, it's just the panel.

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Modification complete")
