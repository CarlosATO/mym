'use client'

import { useRef, useState } from 'react'
import { Download, Loader2, QrCode, Smartphone, UploadCloud } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { Upload } from 'tus-js-client'
import { activateMobileAppRelease, createMobileAppSignedUrl, createMobileAppUploadAuthorization, type ActiveMobileRelease } from '@/app/actions/inventarios/mobile-app'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

function publishedDate(value: string) {
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value))
}

export function InventoryMobileAppCard({ release: initialRelease, canPublish }: { release: ActiveMobileRelease | null; canPublish: boolean }) {
  const [release, setRelease] = useState(initialRelease)
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [qrOpen, setQrOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [version, setVersion] = useState('')
  const [build, setBuild] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [publishState, setPublishState] = useState<'idle' | 'selecting' | 'uploading' | 'registering' | 'complete'>('idle')
  const [progress, setProgress] = useState(0)
  const uploadRef = useRef<Upload | null>(null)

  async function getDownloadUrl() {
    setLoading(true)
    setError(null)
    const result = await createMobileAppSignedUrl()
    setLoading(false)

    if (result.error || !result.signedUrl) {
      setError(result.error ?? 'No se pudo preparar la descarga.')
      return null
    }

    setSignedUrl(result.signedUrl)
    return result.signedUrl
  }

  async function handleDownload() {
    const url = signedUrl ?? await getDownloadUrl()
    if (url) window.location.assign(url)
  }

  async function handleQr() {
    const url = signedUrl ?? await getDownloadUrl()
    if (url) setQrOpen(true)
  }

  async function handlePublish() {
    if (!file || !version.trim() || !/^[1-9]\d*$/.test(build)) return
    setError(null)
    setPublishState('selecting')
    const buildNumber = Number(build)
    const authorization = await createMobileAppUploadAuthorization({ fileName: file.name, fileSize: file.size, version, buildNumber })
    if (authorization.error || !authorization.accessToken || !authorization.storagePath) {
      setError(authorization.error ?? 'No se pudo autorizar la carga.')
      setPublishState('idle')
      return
    }
    const endpoint = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`
    setPublishState('uploading')
    const uploaded = await new Promise<boolean>(resolve => {
      const upload = new Upload(file, {
        endpoint,
        chunkSize: 5 * 1024 * 1024,
        retryDelays: [0, 3000, 5000, 10000],
        uploadDataDuringCreation: false,
        headers: { Authorization: `Bearer ${authorization.accessToken}`, 'x-upsert': 'false' },
        metadata: {
          bucketName: 'mobile-apps', objectName: authorization.storagePath,
          contentType: 'application/vnd.android.package-archive', filetype: 'application/vnd.android.package-archive',
        },
        onError: (uploadError: Error) => {
          setError(uploadError.message || 'La carga falló. Puedes reintentar.')
          setPublishState('idle')
          resolve(false)
        },
        onProgress: (bytesUploaded: number, bytesTotal: number) => setProgress(Math.round((bytesUploaded / bytesTotal) * 100)),
        onSuccess: () => resolve(true),
      })
      uploadRef.current = upload
      upload.findPreviousUploads().then(previousUploads => {
        if (previousUploads.length > 0) upload.resumeFromPreviousUpload(previousUploads[0])
        upload.start()
      }).catch(() => upload.start())
    })
    if (!uploaded) return
    setPublishState('registering')
    const result = await activateMobileAppRelease({ version, buildNumber, storagePath: authorization.storagePath })
    if (result.error || !result.release) {
      setError(result.error ?? 'No se pudo completar la publicación.')
      setPublishState('idle')
      return
    }
    setRelease(result.release)
    setPublishState('complete')
    setFile(null)
    setVersion('')
    setBuild('')
  }

  async function handleFileSelected(selectedFile: File | null) {
    setFile(null)
    setVersion('')
    setBuild('')
    setError(null)
    if (!selectedFile) return
    if (!selectedFile.name.toLowerCase().endsWith('.apk')) {
      setError('Solo se permiten archivos .apk.')
      return
    }
    if (selectedFile.size <= 0 || selectedFile.size > 200 * 1024 * 1024) {
      setError('La APK supera el máximo de 200 MB.')
      return
    }

    setAnalyzing(true)
    try {
      const parserModule = await import('apk-manifest-parser')
      const ManifestParser = (parserModule.default as typeof parserModule.default & { default?: typeof parserModule.default }).default ?? parserModule.default
      const metadata = await ManifestParser.extractApkManifest(selectedFile)
      if (metadata.packageName !== 'cl.petgroup.inventarios') {
        setError('La APK no pertenece a PetGroup Inventarios.')
        return
      }
      if (!metadata.versionName?.trim()) {
        setError('La APK no contiene un versionName válido.')
        return
      }
      if (!Number.isInteger(metadata.versionCode) || metadata.versionCode <= 0) {
        setError('La APK no contiene un versionCode válido.')
        return
      }
      setFile(selectedFile)
      setVersion(metadata.versionName.trim())
      setBuild(String(metadata.versionCode))
    } catch (parseError) {
      console.error('APK metadata parse error:', parseError)
      setError('No se pudo analizar la metadata de la APK.')
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-theme-border/80 bg-theme-surface/80 shadow-sm">
        <div className="flex items-start gap-3 border-b border-theme-border/70 px-4 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
            <Smartphone className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-theme-text">App móvil Inventarios</h2>
            <p className="mt-0.5 text-[11px] text-theme-text-muted/75">Instala la aplicación Android para conteo físico y auditorías.</p>
          </div>
        </div>

        <div className="space-y-3 px-4 py-3">
          {release ? (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-[10px] font-medium text-theme-text-muted/70">Versión</p>
                <p className="mt-0.5 truncate text-sm font-semibold text-theme-text">{release.version}</p>
              </div>
              <div>
                <p className="text-[10px] font-medium text-theme-text-muted/70">Build</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-theme-text">{release.build_number}</p>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-medium text-theme-text-muted/70">Publicada</p>
                <p className="mt-0.5 truncate text-sm font-semibold text-theme-text">{publishedDate(release.published_at)}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm font-medium text-theme-text-muted">Versión no disponible</p>
          )}

          {error && <p className="text-xs text-red-600 dark:text-red-300">{error}</p>}

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={handleDownload} disabled={!release || loading}>
              <Download aria-hidden="true" />
              {loading ? 'Preparando...' : 'Descargar APK'}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={handleQr} disabled={!release || loading}>
              <QrCode aria-hidden="true" />
              Mostrar QR
            </Button>
            {canPublish && <Button type="button" size="sm" variant="outline" onClick={() => { setError(null); setPublishState('idle'); setPublishOpen(true) }}><UploadCloud aria-hidden="true" /> Publicar nueva versión</Button>}
          </div>
        </div>
      </section>

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="max-w-sm text-center">
          <DialogHeader className="items-center pr-7">
            <DialogTitle>Instalar App Inventarios</DialogTitle>
            <DialogDescription>Escanea este código desde un teléfono Android para descargar la APK.</DialogDescription>
          </DialogHeader>
          {signedUrl && release && (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-xl bg-white p-3 shadow-sm">
                <QRCodeSVG value={signedUrl} size={208} includeMargin aria-label="Código QR para descargar App Inventarios" />
              </div>
              <p className="text-xs text-theme-text-muted">Versión {release.version} · Build {release.build_number}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={publishOpen} onOpenChange={open => { if (publishState !== 'uploading' && publishState !== 'registering') setPublishOpen(open) }}>
        <DialogContent className="max-w-md" showCloseButton={publishState !== 'uploading' && publishState !== 'registering'}>
          <DialogHeader>
            <DialogTitle>Publicar nueva versión</DialogTitle>
            <DialogDescription>La versión anterior se conserva y quedará inactiva.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-sm font-medium text-theme-text">Archivo APK<input className="mt-1 block w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm" type="file" accept=".apk,application/vnd.android.package-archive" disabled={publishState !== 'idle' || analyzing} onChange={event => void handleFileSelected(event.target.files?.[0] ?? null)} /></label>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-theme-border bg-theme-text/2 px-3 py-2"><p className="text-[11px] text-theme-text-muted">Versión</p><p className="mt-0.5 text-sm font-semibold text-theme-text">{version || 'Pendiente de análisis'}</p></div>
              <div className="rounded-lg border border-theme-border bg-theme-text/2 px-3 py-2"><p className="text-[11px] text-theme-text-muted">Build</p><p className="mt-0.5 text-sm font-semibold text-theme-text">{build || 'Pendiente de análisis'}</p></div>
            </div>
            {analyzing && <p className="flex items-center gap-2 text-sm text-theme-text-muted"><Loader2 className="size-4 animate-spin" /> Analizando APK...</p>}
            {publishState === 'selecting' && <p className="text-sm text-theme-text-muted">Validando archivo...</p>}
            {publishState === 'uploading' && <div className="space-y-1"><div className="flex justify-between text-xs text-theme-text-muted"><span>Subiendo {progress}%</span><span>No cierres esta ventana</span></div><div className="h-2 overflow-hidden rounded-full bg-theme-border"><div className="h-full bg-theme-accent transition-all" style={{ width: `${progress}%` }} /></div></div>}
            {publishState === 'registering' && <p className="flex items-center gap-2 text-sm text-theme-text-muted"><Loader2 className="size-4 animate-spin" /> Registrando versión...</p>}
            {publishState === 'complete' && <p className="text-sm font-medium text-emerald-600">Publicación completada.</p>}
            {error && <p className="text-xs text-red-600 dark:text-red-300">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={publishState === 'uploading' || publishState === 'registering'} onClick={() => setPublishOpen(false)}>{publishState === 'complete' ? 'Cerrar' : 'Cancelar'}</Button>
            <Button type="button" disabled={!file || !version.trim() || !/^[1-9]\d*$/.test(build) || publishState !== 'idle'} onClick={handlePublish}>Publicar versión</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
