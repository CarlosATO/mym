import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type')
  const search = req.nextUrl.searchParams.get('search') ?? ''
  if (!type) return NextResponse.json([])

  const db = createClient(url!, serviceKey!, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })

  let query = db.from('product_classifiers').select('id, name, normalized_name').eq('classifier_type', type).eq('is_active', true).order('name')

  if (search) {
    const n = search.toUpperCase().trim().replace(/\s+/g, ' ')
    query = query.ilike('normalized_name', `%${n}%`)
  }

  const { data } = await query
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { classifier_type, name } = body
  if (!classifier_type || !name) return NextResponse.json({ error: 'Faltan campos' }, { status: 400 })

  const normalized = name.toUpperCase().trim().replace(/\s+/g, ' ')
  if (!normalized) return NextResponse.json({ error: 'Nombre inválido' }, { status: 400 })

  const db = createClient(url!, serviceKey!, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: existing } = await db.from('product_classifiers').select('id, name').eq('classifier_type', classifier_type).eq('normalized_name', normalized).maybeSingle()
  if (existing) return NextResponse.json({ name: existing.name })

  const { data, error } = await db.from('product_classifiers').insert({
    classifier_type,
    name: normalized,
    normalized_name: normalized,
  }).select('name').single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
