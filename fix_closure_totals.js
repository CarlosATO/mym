const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

async function fix() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      db: { schema: 'adquisiciones' }
    }
  );

  const { data: closures, error: closuresError } = await supabase.from('route_fund_closures').select('id, company_id');
  
  if (closuresError) {
    console.error("Error fetching closures:", closuresError);
    return;
  }

  console.log(`Found ${closures.length} closures. Recalculating...`);

  for (const closure of closures) {
    // Items
    const { data: items } = await supabase.from('route_fund_closure_items')
      .select('payment_method, amount')
      .eq('fund_closure_id', closure.id)
      .is('released_at', null);
      
    let totalCash = 0;
    let totalCheck = 0;
    if (items) {
      items.forEach(item => {
        if (item.payment_method === 'CASH') totalCash += Number(item.amount || 0);
        else if (item.payment_method === 'CHECK') totalCheck += Number(item.amount || 0);
      });
    }

    // Expenses
    const { data: expenses } = await supabase.from('route_fund_closure_expenses').select('amount').eq('fund_closure_id', closure.id);
    const totalExpenses = (expenses || []).reduce((acc, curr) => acc + Number(curr.amount), 0);
    
    // Deposits
    const { data: deposits } = await supabase.from('route_fund_closure_deposits').select('amount').eq('fund_closure_id', closure.id);
    const totalDeposits = (deposits || []).reduce((acc, curr) => acc + Number(curr.amount), 0);

    const totalPending = totalCash + totalCheck - totalExpenses - totalDeposits;

    const { error: updateError } = await supabase.from('route_fund_closures').update({
      total_cash_received: totalCash,
      total_check_received: totalCheck,
      total_expenses: totalExpenses,
      total_deposits: totalDeposits,
      total_pending: totalPending,
      difference_amount: totalPending < 0 ? totalPending : 0
    }).eq('id', closure.id);

    if (updateError) {
      console.error(`Error updating closure ${closure.id}:`, updateError);
    } else {
      console.log(`Updated closure ${closure.id}: Cash: ${totalCash}, Check: ${totalCheck}, Exp: ${totalExpenses}, Dep: ${totalDeposits}, Pend: ${totalPending}`);
    }
  }
}

fix();
