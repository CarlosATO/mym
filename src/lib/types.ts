export interface Profile {
  id: string
  email: string
  nombre: string
  apellido: string
  telefono: string | null
  avatar_url: string | null
  role_id: string
  is_active: boolean
  must_change_password: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
  deleted_at: string | null
}

export interface Rol {
  id: string
  name: string
  description: string | null
  is_active: boolean
  is_system: boolean
}

export interface Modulo {
  id: string
  code: string
  name: string
  description: string | null
  icon: string
  route: string
  sort_order: number
}

export interface Permission {
  id: string
  code: string
  name: string
  description: string | null
  module_id: string | null
  is_active: boolean
}

export type UserWithRole = Profile & { rol: Pick<Rol, 'name' | 'description'> }
