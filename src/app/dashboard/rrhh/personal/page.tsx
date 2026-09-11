import { getEmployees, getRrhhPermissions } from '@/app/actions/rrhh/employees'
import { EmployeesList } from '@/modules/rrhh/components/employees-list'

export default async function RrhhPersonalPage() {
  const [{ canManage }, employees] = await Promise.all([getRrhhPermissions(), getEmployees()])
  return <EmployeesList employees={employees} canManage={canManage} />
}
