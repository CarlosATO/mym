import { notFound } from 'next/navigation'
import { getCommunesCatalog, getEmployee, getRrhhPermissions } from '@/app/actions/rrhh/employees'
import { AccessDenied } from '@/components/access-denied'
import { EmployeeForm } from '@/modules/rrhh/components/employee-form'

export default async function EditEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [employee, { canManage }, communes] = await Promise.all([getEmployee(id), getRrhhPermissions(), getCommunesCatalog()])
  if (!employee) notFound()
  if (!canManage) return <AccessDenied />
  return <EmployeeForm employee={employee} communes={communes} />
}
