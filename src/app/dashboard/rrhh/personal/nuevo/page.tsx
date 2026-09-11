import { getCommunesCatalog, getRrhhPermissions } from '@/app/actions/rrhh/employees'
import { AccessDenied } from '@/components/access-denied'
import { EmployeeForm } from '@/modules/rrhh/components/employee-form'

export default async function NewEmployeePage() {
  const [{ canManage }, communes] = await Promise.all([getRrhhPermissions(), getCommunesCatalog()])
  if (!canManage) return <AccessDenied />
  return <EmployeeForm communes={communes} />
}
