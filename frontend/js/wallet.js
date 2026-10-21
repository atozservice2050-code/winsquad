/* ============================================================
   WALLET — balance, deposit (manual, pending), withdraw request,
   transfer (transfer_funds RPC), transaction history.
   - wallets (own row), transactions (own rows)
   - transfer_funds(p_to_transfer_id, p_amount) -> {ok, error}
     Rules reflected: recipient = 14-digit numeric transfer ID,
     Rs 500 – Rs 10,000, once per day (backend enforces via
     003_transfer_daily.sql; the UI pre-checks the daily limit).
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
  updateTopbarBalance();
}

/* Topbar wallet pill with eye toggle (hide/show) */
let balanceHidden = false;
function updateTopbarBalance() {
  const el = $('topbar-balance');
  if (!el) return;
  el.textContent = balanceHidden ? 'Rs ••••' : 'Rs ' + fmtRs(balance);
}
export function initWalletTopbar() {
  const pill = $('wallet-pill');
  const eye = $('eye-toggle');
  if (!pill || !eye) return;
  // Eye toggles hide/show; pill (excluding eye) could go to wallet view
  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    balanceHidden = !balanceHidden;
    eye.textContent = balanceHidden ? '🙈' : '👁️';
    updateTopbarBalance();
  });
  pill.addEventListener('click', () => {
    // Switch to wallet view
    document.querySelectorAll('.tab').forEach(t => {
      if (t.dataset.view === 'wallet') t.click();
    });
  });
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
      // Amounts are stored positive in the DB; the sign comes from the type.
      // Debits (money leaves the wallet): bets, withdrawals, transfers out, losses.
      const debit = /^(stake|.*_bet|withdraw|transfer_out|.*_loss)$/.test(type);
      div.innerHTML =
        '<div class="txn-type"></div>' +
        '<span class="txn-status ' + status + '">' + status + '</span>' +
        '<span class="txn-amt ' + (debit ? 'neg' : 'pos') + '">' +
          (debit ? '−' : '+') + ' Rs ' + fmtRs(Math.abs(amt)) + '</span>';
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
  if (!amount || amount < 5000) { toast('Minimum deposit is Rs 5,000.', true); return; }
  if (amount > 50000) { toast('Maximum deposit is Rs 50,000.', true); return; }
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
  if (!amount || amount < 10000) { toast('Minimum withdrawal is Rs 10,000.', true); return; }
  if (amount > 50000) { toast('Maximum withdrawal is Rs 50,000.', true); return; }
  const maxWithdraw = Math.floor(balance * 0.5);
  if (amount > maxWithdraw) { toast('Max 50% of balance (Rs ' + fmtRs(maxWithdraw) + ').', true); return; }
  if (amount > balance) { toast('Insufficient balance.', true); return; }
  if (!account) { toast('Enter the account number to receive the money.', true); return; }
  // Once per day: check if user already withdrew today
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: todayWithdrawals } = await supabase.from('transactions')
      .select('id')
      .eq('user_id', userId)
      .eq('type', 'withdraw')
      .gte('created_at', today + 'T00:00:00');
    if (todayWithdrawals && todayWithdrawals.length > 0) {
      toast('Only 1 withdrawal per day allowed. Try tomorrow! 📅', true);
      $('btn-withdraw-submit').disabled = false;
      return;
    }
  } catch (e) { console.warn('withdrawal limit check failed', e); }
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
  if (!amount || amount < 500) { toast('Minimum transfer is Rs 500.', true); return; }
  if (amount > 10000) { toast('Maximum transfer is Rs 10,000.', true); return; }
  if (amount > balance) { toast('Insufficient balance.', true); return; }
  // Once per day: check if user already transferred today
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: todayTransfers } = await supabase.from('transactions')
      .select('id')
      .eq('user_id', userId)
      .in('type', ['transfer_out', 'transfer'])
      .gte('created_at', today + 'T00:00:00');
    if (todayTransfers && todayTransfers.length > 0) {
      toast('Only 1 transfer per day allowed. Try tomorrow! 📅', true);
      $('btn-transfer-submit').disabled = false;
      return;
    }
  } catch (e) { console.warn('transfer limit check failed', e); }
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
    toast(friendlyError(e, 'Transfer failed. Note: only 1 transfer per day is allowed.'), true);
  } finally {
    $('btn-transfer-submit').disabled = false;
  }
}

/* ---------------- payment accounts (Add Account) ----------------
   Saved Easypaisa / JazzCash / Bank accounts (table payment_accounts,
   migration 022). Own rows only (RLS). The primary account auto-fills
   the withdraw form; saved accounts can also be picked there. */
let myAccounts = [];
let editingAccountId = null;

const ACCOUNT_TYPE_LABEL = { easypaisa: 'Easypaisa', jazzcash: 'JazzCash', bank: 'Bank' };

function renderAccounts() {
  const list = $('account-list');
  if (!list) return;
  if (!myAccounts.length) {
    list.innerHTML = '<p class="muted center">No saved accounts yet. Add your Easypaisa, JazzCash or bank account below.</p>';
  } else {
    list.innerHTML = '';
    myAccounts.forEach(acc => {
      const row = document.createElement('div');
      row.className = 'account-row';
      const main = document.createElement('div');
      main.className = 'acct-main';
      const name = document.createElement('div');
      name.className = 'acct-name';
      name.textContent = (ACCOUNT_TYPE_LABEL[acc.type] || acc.type) + ' · ' + acc.holder_name;
      const num = document.createElement('div');
      num.className = 'acct-num';
      num.textContent = acc.account_number + (acc.type === 'bank' && acc.bank_name ? ' · ' + acc.bank_name : '');
      main.appendChild(name); main.appendChild(num);
      row.appendChild(main);
      if (acc.is_primary) {
        const b = document.createElement('span');
        b.className = 'primary-badge'; b.textContent = 'Primary';
        row.appendChild(b);
      }
      const actions = document.createElement('div');
      actions.className = 'acct-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-ghost small'; editBtn.textContent = '✏️ Edit';
      editBtn.addEventListener('click', () => startEditAccount(acc));
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-ghost small'; delBtn.textContent = '🗑 Delete';
      delBtn.addEventListener('click', async () => {
        // In-app two-step confirm (no JS dialogs — WebView blocks them)
        if (delBtn.dataset.confirm !== '1') {
          delBtn.dataset.confirm = '1'; delBtn.textContent = 'Tap again to delete';
          setTimeout(() => { delBtn.dataset.confirm = ''; delBtn.textContent = '🗑 Delete'; }, 3000);
          return;
        }
        delBtn.disabled = true;
        try {
          const { error } = await supabase.from('payment_accounts').delete().eq('id', acc.id);
          if (error) throw error;
          if (editingAccountId === acc.id) resetAccountForm();
          toast('Account deleted.');
          await loadAccounts();
        } catch (e) {
          console.warn('account delete failed', e);
          toast('Could not delete the account.', true);
          delBtn.disabled = false;
        }
      });
      actions.appendChild(editBtn); actions.appendChild(delBtn);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }
  // Populate the withdraw form's saved-account picker
  const sel = $('withdraw-saved');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">Type account manually</option>';
    myAccounts.forEach(acc => {
      const o = document.createElement('option');
      o.value = acc.id;
      o.textContent = (ACCOUNT_TYPE_LABEL[acc.type] || acc.type) + ' · ' + acc.account_number + (acc.is_primary ? ' (Primary)' : '');
      sel.appendChild(o);
    });
    if (prev && myAccounts.some(a => a.id === prev)) sel.value = prev;
  }
}

async function loadAccounts() {
  try {
    const { data, error } = await supabase.from('payment_accounts').select('*')
      .eq('user_id', userId).order('is_primary', { ascending: false }).order('created_at', { ascending: true });
    if (error) throw error;
    myAccounts = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('payment accounts read failed', e);
    myAccounts = [];
    const list = $('account-list');
    if (list) list.innerHTML = '<p class="muted center">Could not load accounts.</p>';
    return;
  }
  renderAccounts();
  // Auto-fill the primary account into the withdraw form (only if empty)
  const primary = myAccounts.find(a => a.is_primary);
  if (primary && $('withdraw-account') && !$('withdraw-account').value) {
    $('withdraw-method').value = primary.type;
    $('withdraw-account').value = primary.account_number;
    if ($('withdraw-saved')) $('withdraw-saved').value = primary.id;
  }
}

function onAccountTypeChange() {
  const type = $('account-type').value;
  $('account-bank-row').hidden = type !== 'bank';
  $('account-number-label').textContent = type === 'bank' ? 'IBAN / account number' : 'Mobile account number';
  $('account-number').placeholder = type === 'bank' ? 'PK36XXXX0000000000000000' : '03XX-XXXXXXX';
}

function resetAccountForm() {
  editingAccountId = null;
  $('account-type').value = 'easypaisa';
  $('account-holder').value = '';
  $('account-bank').value = '';
  $('account-number').value = '';
  $('account-primary').checked = false;
  $('btn-account-save').textContent = 'Save account';
  $('btn-account-cancel').hidden = true;
  onAccountTypeChange();
}

function startEditAccount(acc) {
  editingAccountId = acc.id;
  $('account-type').value = acc.type;
  $('account-holder').value = acc.holder_name || '';
  $('account-bank').value = acc.bank_name || '';
  $('account-number').value = acc.account_number || '';
  $('account-primary').checked = !!acc.is_primary;
  $('btn-account-save').textContent = 'Update account';
  $('btn-account-cancel').hidden = false;
  onAccountTypeChange();
  $('account-holder').focus();
}

async function saveAccount() {
  unlockAudio();
  const type = $('account-type').value;
  const holder = $('account-holder').value.trim();
  const bankName = $('account-bank').value.trim();
  let number = $('account-number').value.trim();
  const isPrimary = $('account-primary').checked || myAccounts.length === 0;
  if (!holder) { toast('Enter the account holder name.', true); return; }
  if (type === 'bank') {
    number = number.replace(/\s+/g, '').toUpperCase();
    if (!bankName) { toast('Enter the bank name.', true); return; }
    if (number.length < 10) { toast('Enter a valid IBAN / account number.', true); return; }
  } else {
    number = number.replace(/[\s-]/g, '');
    if (!/^03\d{9}$/.test(number)) { toast('Enter a valid mobile number (03XXXXXXXXX).', true); return; }
  }
  $('btn-account-save').disabled = true;
  try {
    // Keep exactly one primary: clear the flag on the user's other accounts first
    if (isPrimary) {
      await supabase.from('payment_accounts').update({ is_primary: false }).eq('user_id', userId).eq('is_primary', true);
    }
    const payload = {
      user_id: userId, type, holder_name: holder, account_number: number,
      bank_name: type === 'bank' ? bankName : null, is_primary: isPrimary,
      updated_at: new Date().toISOString(),
    };
    let error;
    if (editingAccountId) {
      ({ error } = await supabase.from('payment_accounts').update(payload).eq('id', editingAccountId));
    } else {
      ({ error } = await supabase.from('payment_accounts').insert(payload));
    }
    if (error) throw error;
    sounds.click();
    toast(editingAccountId ? 'Account updated ✅' : 'Account saved ✅');
    resetAccountForm();
    await loadAccounts();
  } catch (e) {
    console.warn('account save failed', e);
    toast('Could not save the account. Please try again.', true);
  } finally {
    $('btn-account-save').disabled = false;
  }
}

function onWithdrawSavedChange() {
  const acc = myAccounts.find(a => a.id === $('withdraw-saved').value);
  if (!acc) return;
  $('withdraw-method').value = acc.type;
  $('withdraw-account').value = acc.account_number;
}

/* ---------------- init ---------------- */
export function initWallet() {
  $$('.wallet-action').forEach(btn => btn.addEventListener('click', () => {
    unlockAudio();
    const target = btn.dataset.form;
    const form = document.getElementById(target);
    const wasHidden = form.hidden;
    ['deposit-form', 'withdraw-form', 'transfer-form', 'accounts-form'].forEach(id => { $(id).hidden = true; });
    $$('.wallet-action').forEach(b => b.classList.remove('active'));
    if (wasHidden) { form.hidden = false; btn.classList.add('active'); }
  }));
  $('btn-deposit-submit').addEventListener('click', submitDeposit);
  $('btn-withdraw-submit').addEventListener('click', submitWithdraw);
  $('btn-transfer-submit').addEventListener('click', submitTransfer);
  $('btn-account-save').addEventListener('click', saveAccount);
  $('btn-account-cancel').addEventListener('click', resetAccountForm);
  $('account-type').addEventListener('change', onAccountTypeChange);
  $('withdraw-saved').addEventListener('change', onWithdrawSavedChange);
  onAccountTypeChange();
}

export async function refreshWallet() {
  await loadBalance();
  await loadHistory();
  await loadAccounts();
}
