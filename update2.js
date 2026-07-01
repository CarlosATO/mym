const fs = require('fs');
const file = 'src/modules/logistica/recepciones/receipt-worksheet.tsx';
let code = fs.readFileSync(file, 'utf8');

// Imports
code = code.replace(
  "  Eye, PackageOpen\n} from 'lucide-react'\nimport { cn } from '@/lib/utils'",
  "  Eye, PackageOpen\n} from 'lucide-react'\nimport { cn } from '@/lib/utils'\nimport { LocalCombobox } from '@/components/ui/local-combobox'"
);

// Readonly Tipo Recepcion and Bodega de Ingreso
const targetSelects = `<div className="grid grid-cols-2 gap-2 pt-2 border-t border-theme-border/40">
              <div>
                <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold">Tipo Recepción</span>
                <select 
                  value={receivingType} 
                  onChange={e => setReceivingType(e.target.value as any)}
                  disabled={poDetail.po.po_type === 'SERVICIOS'}
                  className="mt-1 h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none w-full shadow-sm"
                >
                  <option value="WAREHOUSE">Física (Bodega)</option>
                  <option value="OFFICE">Administrativa (Oficina)</option>
                </select>
              </div>
              
              <div>
                <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold">Bodega de Ingreso</span>
                <select 
                  value={mainWarehouseId} 
                  onChange={e => setMainWarehouseId(e.target.value)}
                  disabled={receivingType === 'OFFICE'}
                  className="mt-1 h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none w-full disabled:opacity-50 shadow-sm"
                >
                  <option value="">Seleccionar...</option>
                  {poDetail.po.warehouse_id && (
                    <option value={poDetail.po.warehouse_id}>
                      {poDetail.po.warehouse_name} (Origen)
                    </option>
                  )}
                </select>
              </div>
            </div>`;

const newReadonly = `<div className="grid grid-cols-2 gap-2 pt-2 border-t border-theme-border/40">
              <div>
                <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold">Tipo Recepción</span>
                <div className="mt-1 flex items-center h-8 rounded-lg border border-theme-border/50 bg-theme-text/[0.02] px-2.5 text-xs font-semibold text-theme-text shadow-sm cursor-not-allowed">
                  {receivingType === 'WAREHOUSE' ? 'Física (Bodega)' : 'Administrativa (Oficina)'}
                </div>
              </div>
              
              <div>
                <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold">Bodega de Ingreso</span>
                <div className="mt-1 flex items-center h-8 rounded-lg border border-theme-border/50 bg-theme-text/[0.02] px-2.5 text-xs font-semibold text-theme-text shadow-sm cursor-not-allowed">
                  {receivingType === 'OFFICE' ? '—' : (poDetail.po.warehouse_name || 'No asignada')}
                </div>
              </div>
            </div>`;

code = code.replace(targetSelects, newReadonly);

// Replace select location in splits
const targetLocationSelect = `<select
                                      value={split.location_id}
                                      onChange={e => updateSplitField(item.id, split.id, 'location_id', e.target.value)}
                                      className="h-7 rounded border border-theme-border/80 bg-theme-surface px-1.5 text-[11px] text-theme-text font-bold focus:outline-none focus:ring-1 focus:ring-theme-accent/30"
                                    >
                                      <option value="">Seleccionar...</option>
                                      {whLocs.map(l => (
                                        <option key={l.id} value={l.id}>{l.code}</option>
                                      ))}
                                    </select>`;

const newLocationCombobox = `<LocalCombobox
                                      value={split.location_id}
                                      onChange={val => updateSplitField(item.id, split.id, 'location_id', val)}
                                      options={whLocs.map(l => ({
                                        value: l.id,
                                        label: \`\${l.code} · \${l.name}\`
                                      }))}
                                      placeholder="Buscar ubic..."
                                      className="w-36 h-7 rounded border border-theme-border/80 bg-theme-surface px-2 text-[10px] text-theme-text font-bold focus:ring-1 focus:ring-theme-accent/30"
                                    />`;

code = code.replace(targetLocationSelect, newLocationCombobox);

fs.writeFileSync(file, code, 'utf8');
