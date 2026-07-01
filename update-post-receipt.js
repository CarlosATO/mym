const fs = require('fs');

// 1. Update logistica-layout-client.tsx
let layoutFile = 'src/app/dashboard/logistica/logistica-layout-client.tsx';
let layoutCode = fs.readFileSync(layoutFile, 'utf8');

layoutCode = layoutCode.replace(
  "import { useState } from 'react'",
  "import { useState, useEffect } from 'react'"
);

const layoutStateInit = `  const [activeTab, setActiveTab] = useState('inicio')
  const [activeActionId, setActiveActionId] = useState('resumen')`;

const newLayoutStateInit = `  const [activeTab, setActiveTab] = useState('inicio')
  const [activeActionId, setActiveActionId] = useState('resumen')

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const tab = params.get('tab')
      const action = params.get('action')
      if (tab) setActiveTab(tab)
      if (action) setActiveActionId(action)
    }
  }, [])`;

layoutCode = layoutCode.replace(layoutStateInit, newLayoutStateInit);
fs.writeFileSync(layoutFile, layoutCode, 'utf8');

// 2. Update receipt-worksheet.tsx
let receiptFile = 'src/modules/logistica/recepciones/receipt-worksheet.tsx';
let receiptCode = fs.readFileSync(receiptFile, 'utf8');

const routerPushOld = `      router.push('/dashboard/logistica')
      setTimeout(() => {
        window.location.reload()
      }, 100)`;

const routerPushNew = `      window.location.assign(\`/dashboard/logistica?tab=movimientos&action=recepciones&poId=\${poDetail.po.id}&successReceipt=\${res.receipt_number}\`)`;

receiptCode = receiptCode.replace(routerPushOld, routerPushNew);

// Change button text
const btnOld = `{saving ? 'Registrar Recepción' : 'Registrar Recepción'}`; // Wait, it doesn't have this, it has "<span>Registrar Recepción</span>"
const btnSpanOld = `<span>Registrar Recepción</span>`;
const btnSpanNew = `<span>{saving ? 'Registrando recepción...' : 'Registrar Recepción'}</span>`;

receiptCode = receiptCode.replace(btnSpanOld, btnSpanNew);

fs.writeFileSync(receiptFile, receiptCode, 'utf8');

// 3. Update recepciones-panel.tsx
let panelFile = 'src/modules/logistica/recepciones/recepciones-panel.tsx';
let panelCode = fs.readFileSync(panelFile, 'utf8');

const loadPOsCall = `  const loadPOs = useCallback(async () => {`;
const initialPoIdSet = `  const [initialPoIdSet, setInitialPoIdSet] = useState(false)
  
  useEffect(() => {
    if (pos.length > 0 && !initialPoIdSet && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const poId = params.get('poId')
      if (poId) {
        setDetailPoId(poId)
      }
      setInitialPoIdSet(true)
    }
  }, [pos, initialPoIdSet])

  const loadPOs = useCallback(async () => {`;

panelCode = panelCode.replace(loadPOsCall, initialPoIdSet);

const detailPanelFunc = `    onReceive: (id: string) => void
  }) {
    const [detail, setDetail] = useState<any>(cachedDetail)
    const [loadingDetail, setLoadingDetail] = useState(!cachedDetail)`;

const detailPanelFuncNew = `    onReceive: (id: string) => void
  }) {
    const [detail, setDetail] = useState<any>(cachedDetail)
    const [loadingDetail, setLoadingDetail] = useState(!cachedDetail)
    const [successReceipt, setSuccessReceipt] = useState<string | null>(null)

    useEffect(() => {
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search)
        const sr = params.get('successReceipt')
        const paramPoId = params.get('poId')
        if (sr && summary.id === paramPoId) {
          setSuccessReceipt(sr)
          window.history.replaceState({}, '', \`/dashboard/logistica?tab=movimientos&action=recepciones&poId=\${summary.id}\`)
        }
      }
    }, [summary.id])`;

panelCode = panelCode.replace(detailPanelFunc, detailPanelFuncNew);

const detailHeader = `      <div className="h-full flex flex-col bg-theme-surface border-l border-theme-border">
  
        {/* "?"? Header (fixed height, no excessive padding) "?"? */}
        <div className="shrink-0 border-b border-theme-border/70">
          {/* Title row */}
          <div className="flex items-center justify-between gap-4 px-5 py-3 bg-theme-text/[0.02]">`;

const detailHeaderNew = `      <div className="h-full flex flex-col bg-theme-surface border-l border-theme-border">
  
        {/* "?"? Header (fixed height, no excessive padding) "?"? */}
        <div className="shrink-0 border-b border-theme-border/70">
          {successReceipt && (
            <div className="bg-emerald-500/10 border-b border-emerald-500/20 px-5 py-2.5 flex items-center justify-between animate-in fade-in slide-in-from-top-2 duration-300">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                  Recepción <span className="font-mono text-emerald-700 dark:text-emerald-300">{successReceipt}</span> registrada correctamente
                </span>
              </div>
              <button onClick={() => setSuccessReceipt(null)} className="text-emerald-600 hover:bg-emerald-500/10 p-1 rounded transition-colors" title="Cerrar aviso">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {/* Title row */}
          <div className="flex items-center justify-between gap-4 px-5 py-3 bg-theme-text/[0.02]">`;

panelCode = panelCode.replace(detailHeader, detailHeaderNew);

fs.writeFileSync(panelFile, panelCode, 'utf8');
