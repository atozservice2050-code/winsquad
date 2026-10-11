/* ============================================================
   WALLET — balance, deposit (manual, pending), withdraw request,
   transfer (transfer_funds RPC), transaction history.
   - wallets (own row), transactions (own rows)
   - transfer_funds(p_to_transfer_id, p_amount) -> {ok, error}
     Rules reflected: recipient = 14-digit numeric transfer ID,
     max 50% of balance, once per week (backend enforces; the UI
     pre-checks the 50% rule and shows the weekly limit).
   - Deposit/withdraw are MANUAL: the UI inserts pending rows into
     the `transactions` ledger (type='deposit'/'withdraw',
     status='pending'); an admin approves deposits via
     approve_deposit(), which credits the wallet.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, fmtTime, unlockAudio, sounds } from './util.js';

let userId = null;
let balance = 0;

export function setUser(id) { userId = id; }

async function loadBalance() {
  try {
    const { data } = await supabase.from('wallets').select('balance').eq('user_id', userId).maybeSingle();
    balance = Number(unwrapRow(data)?.balance ?? 0);
  } catch (e) { console.warn('wallet read failed', e); }
  $('wallet-balance').textContent = fmtRs(balance);
}

async function loadHistory() {
  const list = $('txn-list');
  try {
    const { data } = await supabase.from('transactions').select('*')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(40);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      list.innerHTML = '<p class="muted center">No transactions yet.</p>';
      return;
    }
    list.innerHTML = '';
    rows.forEach(t => {
      const amt = Number(t.amount || 0);
      const div = document.createElement('div');
      div.className = 'txn-row';
      const type = String(t.type || t.kind || 'transaction');
      const date = fmtTime(t.created_at);
      const status = String(t.status || 'completed').toLowerCase();
      div.innerHTML =
        '<div class="txn-type"></div>' +
        '<span class="txn-status ' + status + '">' + status + '</span>' +
        '<span class="txn-amt ' + (amt >= 0 ? 'pos' : 'neg') + '">' +
          (amt >= 0 ? '+' : '−') + ' Rs ' + fmtRs(Math.abs(amt)) + '</span>';
      const typeEl = div.querySelector('.txn-type');
      typeEl.textContent = type.replace(/_/g, ' ');
      const d = document.createElement('span');
      d.className = 'txn-date';
      d.textContent = date;
      typeEl.appendChild(d);
      list.appendChild(div);
    });
  } catch (e) {
    console.warn('transactions read failed', e);
    list.innerHTML = '<p class="muted center">Could not load history.</p>';
  }
}

/* ---------------- deposit (manual, pending) ----------------
   Inserts a pending row into the transactions ledger; an admin
   approves it via approve_deposit(), which credits the wallet. */
async function submitDeposit() {
  unlockAudio();
  const method = $('deposit-method').value;
  const amount = Number($('deposit-amount').value);
  const txnId = $('deposit-txn').value.trim();
  if (!amount || amount < 10) { toast('Minimum deposit is Rs 10.', true); return; }
  if (!txnId) { toast('Paste the transaction ID from your payment app.', true); return; }
  $('btn-deposit-submit').disabled = true;
  try {
    const { error } = await supabase.from('transactions').insert({
      user_id: userId, type: 'deposit', amount, status: 'pending',
      method, external_txn_id: txnId,
    });
    if (error) throw error;
    sounds.click();
    toast('Deposit submitted — status: pending ⏳');
    $('deposit-amount').value = '';
    $('deposit-txn').value = '';
    loadHistory();
  } catch (e) {
    console.warn('deposit insert failed', e);
    toast('Could not submit the deposit request. Please contact support with your transaction ID.', true);
  } finally {
    $('btn-deposit-submit').disabled = false;
  }
}

/* ---------------- withdraw request (manual, pending) ----------------
   Inserts a pending withdraw row; admin processes it off-app. */
async function submitWithdraw() {
  unlockAudio();
  const amount = Number($('withdraw-amount').value);
  const method = $('withdraw-method').value;
  const account = $('withdraw-account').value.trim();
  if (!amount || amount < 100) { toast('Minimum withdrawal is Rs 100.', true); return; }
  if (amount > balance) { toast('Insufficient balance.', true); return; }
  if (!account) { toast('Enter the account number to receive the money.', true); return; }
  $('btn-withdraw-submit').disabled = true;
  try {
    const { error } = await supabase.from('transactions').insert({
      user_id: userId, type: 'withdraw', amount, status: 'pending',
      method, note: 'To account: ' + account,
    });
    if (error) throw error;
    sounds.click();
    toast('Withdrawal requested — status: pending ⏳');
    $('withdraw-amount').value = '';
    $('withdraw-account').value = '';
    loadHistory();
  } catch (e) {
    console.warn('withdraw insert failed', e);
    toast('Could not submit the withdrawal request. Please contact support.', true);
  } finally {
    $('btn-withdraw-submit').disabled = false;
  }
}

/* ---------------- transfer ---------------- */
async function submitTransfer() {
  unlockAudio();
  const to = $('transfer-to').value.trim();
  const amount = Number($('transfer-amount').value);
  if (!/^\d{14}$/.test(to)) { toast('Transfer ID must be exactly 14 digits.', true); return; }
  if (!amount || amount < 10) { toast('Minimum transfer is Rs 10.', true); return; }
  const maxAllowed = Math.floor(balance * 0.5);
  if (amount > maxAllowed) {
    toast('Limit: max 50% of balance (Rs ' + fmtRs(maxAllowed) + ').', true);
    return;
  }
  $('btn-transfer-submit').disabled = true;
  try {
    const { data, error } = await supabase.rpc('transfer_funds', {
      p_to_transfer_id: to, p_amount: amount,
    });
    if (error) throw error;
    const row = unwrapRow(data);
    if (row && row.ok === false) throw new Error(row.error || 'Transfer failed');
    sounds.win();
    toast('🔁 Rs ' + fmtRs(amount) + ' sent!');
    $('transfer-to').value = '';
    $('transfer-amount').value = '';
    await loadBalance();
    await loadHistory();
  } catch (e) {
    toast(friendlyError(e, 'Transfer failed. Note: transfers are limited to once per week.'), true);
  } finally {
    $('btn-transfer-submit').disabled = false;
  }
}

/* ---------------- init ---------------- */
export function initWallet() {
  $$('.wallet-action').forEach(btn => btn.addEventListener('click', () => {
    unlockAudio();
    const target = btn.dataset.form;
    const form = document.getElementById(target);
    const wasHidden = form.hidden;
    ['deposit-form', 'withdraw-form', 'transfer-form'].forEach(id => { $(id).hidden = true; });
    $$('.wallet-action').forEach(b => b.classList.remove('active'));
    if (wasHidden) { form.hidden = false; btn.classList.add('active'); }
  }));
  $('btn-deposit-submit').addEventListener('click', submitDeposit);
  $('btn-withdraw-submit').addEventListener('click', submitWithdraw);
  $('btn-transfer-submit').addEventListener('click', submitTransfer);
}

export async function refreshWallet() {
  await loadBalance();
  await loadHistory();
}
