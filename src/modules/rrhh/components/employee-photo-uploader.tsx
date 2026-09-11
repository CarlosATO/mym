'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { getEmployeePhotoUrl, prepareEmployeePhotoUpload, saveEmployeePhoto } from '@/app/actions/rrhh/employees'
import { EmployeeIdentityCard } from './employee-identity-card'

export function EmployeePhotoUploader({ employee, canEdit, photoUrl: initialPhotoUrl }: { employee: { id: string; nombres: string; apellido_paterno: string; apellido_materno: string | null; rut: string; cargo: string; estado: 'ACTIVO' | 'INACTIVO'; profile_photo_path: string | null }; canEdit: boolean; photoUrl: string | null }) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(initialPhotoUrl)
  const [saving, setSaving] = useState(false)
  const name = `${employee.nombres} ${employee.apellido_paterno} ${employee.apellido_materno ?? ''}`.trim()

  async function selectPhoto(file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { toast.error('La foto debe ser JPG, PNG o WebP y pesar hasta 5 MB.'); return }
    const preview = URL.createObjectURL(file)
    setPhotoUrl(preview)
    setSaving(true)
    const prepared = await prepareEmployeePhotoUpload(employee.id, file.type, file.size)
    if (prepared.error || !prepared.path || !prepared.token) { setSaving(false); toast.error(prepared.error ?? 'No se pudo preparar la foto.'); return }
    const { error: uploadError } = await createClient().storage.from('rrhh-profile-photos').uploadToSignedUrl(prepared.path, prepared.token, file, { contentType: file.type })
    if (uploadError) { setSaving(false); toast.error('No se pudo subir la fotografía.'); return }
    const saved = await saveEmployeePhoto(employee.id, prepared.path, file.type, file.size)
    if (saved.error) { setSaving(false); toast.error(saved.error); return }
    const signedUrl = await getEmployeePhotoUrl(prepared.path)
    setPhotoUrl(signedUrl)
    setSaving(false)
    toast.success('Fotografía actualizada.')
  }

  return <div className="relative">{saving && <span className="absolute inset-x-0 top-1 z-10 text-center text-[10px] font-semibold text-theme-accent">Subiendo foto...</span>}<EmployeeIdentityCard name={name} rut={employee.rut} cargo={employee.cargo} estado={employee.estado} photoUrl={photoUrl} canEdit={canEdit && !saving} onPhotoSelected={selectPhoto} /></div>
}
