import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const publicRoutes = ['/login', '/change-password']

const cronRoutes = [
  '/api/integraciones/bsale/clients/sync',
  '/api/integraciones/bsale/product-types/sync',
  '/api/integraciones/bsale/products/sync',
  '/api/cron/sync-replenishment'
]

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'portal' },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options))
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  const path = request.nextUrl.pathname

  if (!user) {
    if (publicRoutes.includes(path) || path === '/' || cronRoutes.includes(path)) {
      return supabaseResponse
    }
    if (path.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (path === '/' || path === '/login') {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  if (publicRoutes.includes(path)) {
    return supabaseResponse
  }

  const { data: profile } = await supabase
    .from('users')
    .select('must_change_password')
    .eq('id', user.id)
    .maybeSingle()

  if (profile?.must_change_password) {
    return NextResponse.redirect(new URL('/change-password', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
