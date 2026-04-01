/**
 * ============================================================
 *  Verifica Placa — Apps Script Unificado
 *  Pagar.me Core v5  +  RevenueDaily
 *
 *  Uma única planilha, um único projeto, um único trigger.
 *
 *  Abas criadas automaticamente:
 *    Config, Orders, OrderItems, RevenueDaily,
 *    Charges, Payables, Settlements, BalanceOperations,
 *    Recipients, RecipientBalance
 *
 *  Config (coluna A = chave, B = valor):
 *    created_since               ex: 2024-01-01T00:00:00Z
 *    created_until               ex: 2024-12-31T23:59:59Z
 *    page_size                   default 50 (max 100)
 *    recipient_id                ID do recipient Pagar.me
 *    orderitems_lookback_hours   default 24 (janela do sync horário de Orders/Items)
 *    backoffice_lookback_hours   default 48 (janela do sync diário de Charges/Payables/etc)
 *    paid_statuses               default "paid"
 *    lookback_days               default 0 (0 = histórico completo)
 *    source_orders_sheet         default "Orders"
 *
 *  Script Properties (Editor > Propriedades do projeto):
 *    PAGARME_SECRET_KEY          sua chave secreta da Pagar.me
 *    SPREADSHEET_ID              preenchido automaticamente pelo setup
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
//  CONSTANTES
// ─────────────────────────────────────────────────────────────
const PAGARME_BASE   = "https://api.pagar.me/core/v5";
const PROP_SECRET    = "PAGARME_SECRET_KEY";
const PROP_SSID      = "SPREADSHEET_ID";
const PROP_SB_URL    = "SUPABASE_URL";       // ex: https://xyzxyz.supabase.co
const PROP_SB_KEY    = "SUPABASE_ANON_KEY";  // anon key do projeto
const CONFIG_SHEET      = "Config";
const REVENUE_SHEET     = "RevenueDaily";
const BUREAU_SHEET      = "BureauDaily";
const UPSELL_SHEET      = "UpsellDaily";
const UPSELL_TYPE_SHEET = "UpsellByType";
const TZ                = "America/Sao_Paulo";

// ─────────────────────────────────────────────────────────────
//  MENU
// ─────────────────────────────────────────────────────────────
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu("Pagar.me")
      .addItem("1) Setup inicial (vincular planilha)", "setupSpreadsheetId")
      .addSeparator()
      .addItem("▶ Sync completo (Orders + RevenueDaily + Dashboard)", "syncAll")
      .addItem("▶ Sync backoffice incremental (últimas 48h)", "syncBackoffice")
      .addItem("▶ Sync backoffice COMPLETO (histórico Config)", "syncBackofficeFull")
      .addSeparator()
      .addItem("Orders + OrderItems (janela recente)", "syncOrdersAndItems")
      .addItem("Orders + OrderItems (histórico completo)", "syncOrdersAndItemsFull")
      .addItem("RevenueDaily (agrega Orders → diário)", "syncRevenueDailyFromOrdersSheet")
      .addItem("UpsellDaily (acumula addons por dia)", "syncUpsellDaily")
      .addItem("UpsellDaily (histórico completo)", "syncUpsellFull")
      .addItem("UpsellByType (breakdown por tipo)", "syncUpsellByType")
      .addItem("Dashboard (consolida GAds + Pagar.me)", "syncDashboard")
      .addItem("Bureau (Supabase → BureauDaily)", "syncBureauFromSupabase")
      .addSeparator()
      .addItem("Charges",            "syncCharges")
      .addItem("Payables",           "syncPayables")
      .addItem("Settlements",        "syncSettlements")
      .addItem("Balance Operations", "syncBalanceOperations")
      .addItem("Recipients",         "syncRecipients")
      .addItem("Recipient Balance",  "syncRecipientBalance")
      .addSeparator()
      .addItem("⏱ Configurar triggers automáticos", "setupAutoSync")
      .addToUi();
  } catch (_) { /* sem UI (trigger headless) */ }
}

// ─────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────
function setupSpreadsheetId() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("Abra a planilha e rode setupSpreadsheetId novamente.");
  PropertiesService.getScriptProperties().setProperty(PROP_SSID, ss.getId());
  getOrCreateSheet_(CONFIG_SHEET);
  SpreadsheetApp.getActiveSpreadsheet()
    .toast("Planilha vinculada com sucesso! Rode 'setupAutoSync' para ativar os triggers.", "Setup OK", 8);
}

// ─────────────────────────────────────────────────────────────
//  ORQUESTRAÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * syncAll — chamado pelo trigger a cada hora.
 * 1) Puxa Orders + OrderItems da Pagar.me
 * 2) Agrega RevenueDaily a partir dos Orders
 */
function syncAll() {
  // Evita execuções concorrentes (ex: trigger disparou enquanto o anterior ainda rodava)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log("syncAll: outra execução já está em andamento. Pulando.");
    return;
  }
  try {
    try { syncOrdersAndItems(); }
    catch (e) { setLastError_("orders_items: " + String(e)); }

    try { syncRevenueDailyFromOrdersSheet(); }
    catch (e) { setLastError_("revenue_daily: " + String(e)); }

    try { syncUpsellDaily(); }
    catch (e) { setLastError_("upsell_daily: " + String(e)); }

    try { syncUpsellByType(); }
    catch (e) { setLastError_("upsell_by_type: " + String(e)); }
    // syncDashboard roda no seu próprio trigger (a cada 30min via setupAutoSync)
    // para não sobrecarregar o trigger horário do syncAll.
  } finally {
    lock.releaseLock();
    _ssCache = null; // limpa cache após execução
  }
}

/**
 * syncBackoffice — chamado 1x por dia às 6h.
 * Modo incremental: busca apenas as últimas backoffice_lookback_hours (padrão 48h)
 * e faz upsert no histórico existente. Status de Charges/Payables podem mudar.
 */
function syncBackoffice() {
  _syncBackoffice({ fullHistory: false });
}

/**
 * syncBackofficeFull — carga completa usando created_since/created_until da Config.
 * Rode manualmente uma vez para popular o histórico inicial, ou após mudar o período.
 */
function syncBackofficeFull() {
  _syncBackoffice({ fullHistory: true });
}

function _syncBackoffice(opts) {
  const full = opts && opts.fullHistory;
  try { _syncCharges(full); }           catch (e) { setLastError_("charges: " + String(e)); }
  try { _syncPayables(full); }          catch (e) { setLastError_("payables: " + String(e)); }
  try { _syncSettlements(full); }       catch (e) { setLastError_("settlements: " + String(e)); }
  try { _syncBalanceOperations(full); } catch (e) { setLastError_("balance_ops: " + String(e)); }
  try { syncRecipients(); }             catch (e) { setLastError_("recipients: " + String(e)); }
}

// ─────────────────────────────────────────────────────────────
//  ORDERS + ORDER ITEMS
// ─────────────────────────────────────────────────────────────
function syncOrdersAndItems()     { _syncOrdersAndItems({ fullHistory: false }); }
function syncOrdersAndItemsFull() { _syncOrdersAndItems({ fullHistory: true }); }

function _syncOrdersAndItems(opts) {
  const cfg = getConfig_();
  const params = { page: 1, size: cfg.page_size };
  const full   = opts && opts.fullHistory;

  if (full) {
    if (cfg.created_since) params.created_since = cfg.created_since;
    if (cfg.created_until) params.created_until = cfg.created_until;
  } else {
    const hours = Math.max(parseInt(cfg.orderitems_lookback_hours || "24", 10) || 24, 1);
    const now   = new Date();
    const since = new Date(now.getTime() - hours * 3600 * 1000);
    params.created_since = since.toISOString();
    params.created_until = now.toISOString();
  }

  params.expand = "items,customer";
  const orders = fetchAllPaged_("/orders", params) || [];

  // Orders: sempre faz upsert por order_id (preserva histórico e atualiza status)
  writeOrdersHistory_(orders);

  // OrderItems:
  //   - Full → clear + rewrite completo (carga inicial ou reconstrução)
  //   - Diário → apenas appenda ordens ainda não presentes (itens são imutáveis)
  if (full) {
    writeOrderItemsFull_(orders);
  } else {
    writeOrderItemsAppend_(orders);
  }

  setConfigValue_("last_sync_orders_items", new Date().toISOString());
  setConfigValue_("last_error", "");
}

// ─────────────────────────────────────────────────────────────
//  REVENUE DAILY (agrega Orders → 1 linha por dia)
// ─────────────────────────────────────────────────────────────
function syncRevenueDailyFromOrdersSheet() {
  const ss = getSpreadsheet_();

  try {
    const cfg = getConfig_();

    // Lê da mesma planilha — sem dependência externa
    const ordersSheetName = String(cfg.source_orders_sheet || "Orders").trim();
    const sh = ss.getSheetByName(ordersSheetName);
    if (!sh) throw new Error(`Aba "${ordersSheetName}" não encontrada. Rode syncOrdersAndItems primeiro.`);

    const values = sh.getDataRange().getValues();
    if (values.length < 2) throw new Error("Aba Orders vazia.");

    // Normaliza cabeçalhos
    const header = values[0].map(h => _normalizeHeader(h));
    const col    = name => header.indexOf(_normalizeHeader(name));

    const cStatus    = col("status");
    const cAmount    = col("amount");
    const cUpdatedAt = col("updated_at");
    const cCreatedAt = col("created_at");

    if (cStatus < 0 || cAmount < 0)
      throw new Error('Colunas "status" e/ou "amount" não encontradas na aba Orders.');
    if (cUpdatedAt < 0 && cCreatedAt < 0)
      throw new Error('Colunas "updated_at" / "created_at" não encontradas na aba Orders.');

    // Statuses que contam como receita
    const paidStr = String(cfg.paid_statuses || "paid").toLowerCase();
    const PAID    = new Set(paidStr.split(",").map(s => s.trim()).filter(Boolean));

    // Janela de recálculo
    const lookbackDays = parseInt(String(cfg.lookback_days || "0"), 10) || 0;
    const minDate = lookbackDays > 0
      ? new Date(Date.now() - lookbackDays * 86400 * 1000)
      : null;

    const dest = ss.getSheetByName(REVENUE_SHEET) || ss.insertSheet(REVENUE_SHEET);

    // 1) Preserva histórico fora da janela
    const finalMap = new Map(); // yyyy-mm-dd → { revenue, orders }
    const existing = dest.getDataRange().getValues();
    if (existing.length > 1) {
      for (let i = 1; i < existing.length; i++) {
        const row = existing[i];
        const dt  = row[0];
        if (!(dt instanceof Date)) continue;
        const key = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
        if (minDate && dt >= minDate) continue; // será recalculado
        finalMap.set(key, { revenue: Number(row[1] || 0), orders: Number(row[3] || 0) });
      }
    }

    // 2) Recalcula janela recente
    const recentMap = new Map();
    for (let i = 1; i < values.length; i++) {
      const row    = values[i];
      const status = String(row[cStatus] || "").trim().toLowerCase();
      if (!PAID.has(status)) continue;

      const dtRaw = (cUpdatedAt >= 0 && row[cUpdatedAt]) ? row[cUpdatedAt] : row[cCreatedAt];
      const dt    = _parseDate(dtRaw);
      if (!dt) continue;
      if (minDate && dt < minDate) continue;

      const cents = Number(row[cAmount] || 0);
      if (!cents || cents <= 0) continue;

      const key = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
      if (!recentMap.has(key)) recentMap.set(key, { revenue: 0, orders: 0 });
      const agg = recentMap.get(key);
      agg.revenue += cents / 100;
      agg.orders  += 1;
    }

    // 3) Sobrescreve com dados recalculados
    for (const [k, v] of recentMap.entries()) finalMap.set(k, v);

    // 4) Escreve na aba RevenueDaily
    const keys = Array.from(finalMap.keys()).sort();
    const out  = keys.map(k => {
      const a = finalMap.get(k);
      return [new Date(k + "T00:00:00"), a.revenue, "", a.orders, "", ""];
    });

    dest.clear({ contentsOnly: true });
    dest.getRange(1, 1, 1, 6).setValues([[
      "data", "receita_bruta", "receita_liquida (opcional)",
      "pedidos_pagos", "compradores_unicos", "obs"
    ]]);

    if (out.length) {
      dest.getRange(2, 1, out.length, 6).setValues(out);
      dest.getRange(2, 1, out.length, 1).setNumberFormat("yyyy-mm-dd");
      dest.getRange(2, 2, out.length, 1).setNumberFormat('R$ #,##0.00');
      dest.getRange(2, 4, out.length, 1).setNumberFormat('0');
    }

    setConfigValue_("last_sync_revenue_daily", new Date().toISOString());
    setConfigValue_("last_error", "");
    ss.toast(`RevenueDaily atualizado: ${out.length} dias.`, "OK", 4);

  } catch (err) {
    const msg = (err && err.stack) ? err.stack : String(err);
    setLastError_(msg);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
//  UPSELL DAILY — acumula pedidos com addon por dia
// ─────────────────────────────────────────────────────────────

/**
 * syncUpsellDaily — lê a aba OrderItems (janela recente) e agrega
 * o número de pedidos PAGOS que têm pelo menos 1 item ADDON por dia.
 * Preserva histórico como o RevenueDaily: só recalcula a janela
 * definida por orderitems_lookback_hours, mantendo datas antigas intactas.
 *
 * Aba "UpsellDaily": data | pedidos_upsell
 */
function syncUpsellDaily() {
  const ss  = getSpreadsheet_();
  const cfg = getConfig_();

  const itemsSh = ss.getSheetByName("OrderItems");
  if (!itemsSh) {
    Logger.log("UpsellDaily: aba OrderItems não encontrada — rode syncOrdersAndItems primeiro.");
    return;
  }

  const itemValues = itemsSh.getDataRange().getValues();
  if (itemValues.length < 2) return;

  const h          = itemValues[0].map(v => _normalizeHeader(v));
  const cOrderId   = h.findIndex(v => v === "order_id");
  const cDate      = h.findIndex(v => v === "order_created_at");
  const cType      = h.findIndex(v => v === "item_type");
  const cStatus    = h.findIndex(v => v === "order_status");

  if (cOrderId < 0 || cDate < 0 || cType < 0) {
    Logger.log("UpsellDaily: colunas necessárias não encontradas em OrderItems. Headers: " + h.join(", "));
    return;
  }

  // Janela de recálculo (espelha orderitems_lookback_hours)
  const hours   = Math.max(parseInt(cfg.orderitems_lookback_hours || "24", 10) || 24, 1);
  const minDate = new Date(Date.now() - hours * 3600 * 1000);

  // 1ª passagem: quais order_ids têm pelo menos 1 ADDON?
  const addonOrders = new Set();
  for (let i = 1; i < itemValues.length; i++) {
    if (String(itemValues[i][cType] || "").toUpperCase() === "ADDON") {
      addonOrders.add(String(itemValues[i][cOrderId] || ""));
    }
  }

  // 2ª passagem: data de cada pedido addon (distinct, paid, dentro da janela)
  const recentMap = new Map(); // "yyyy-MM-dd" → count
  const seen      = new Set();
  for (let i = 1; i < itemValues.length; i++) {
    const row     = itemValues[i];
    const orderId = String(row[cOrderId] || "");
    const status  = String(row[cStatus]  || "").toLowerCase();
    if (!addonOrders.has(orderId) || status !== "paid" || seen.has(orderId)) continue;
    seen.add(orderId);
    const dt = _parseDate(row[cDate]);
    if (!dt || dt < minDate) continue;
    const key = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
    recentMap.set(key, (recentMap.get(key) || 0) + 1);
  }

  // Preserva histórico fora da janela
  const dest     = getOrCreateSheet_(UPSELL_SHEET);
  const existing = dest.getDataRange().getValues();
  const finalMap = new Map();

  if (existing.length > 1) {
    for (let i = 1; i < existing.length; i++) {
      const row = existing[i];
      const dt  = row[0];
      if (!(dt instanceof Date)) continue;
      if (dt.getTime() >= minDate.getTime()) continue; // será recalculado
      const key = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
      finalMap.set(key, Number(row[1] || 0));
    }
  }

  // Sobrescreve janela recente
  for (const [k, v] of recentMap.entries()) finalMap.set(k, v);

  // Grava na aba UpsellDaily
  const keys = Array.from(finalMap.keys()).sort();
  const out  = keys.map(k => [new Date(k + "T12:00:00"), finalMap.get(k)]);

  dest.clearContents();
  dest.getRange(1, 1, 1, 2).setValues([["data", "pedidos_upsell"]]);
  if (out.length) {
    dest.getRange(2, 1, out.length, 2).setValues(out);
    dest.getRange(2, 1, out.length, 1).setNumberFormat("yyyy-mm-dd");
    dest.getRange(2, 2, out.length, 1).setNumberFormat("0");
  }
  dest.autoResizeColumns(1, 2);
  setConfigValue_("last_sync_upsell", new Date().toISOString());
  ss.toast("UpsellDaily atualizado: " + out.length + " dias.", "OK", 4);
}

/**
 * syncUpsellFull — backfill completo do histórico de upsell a partir de TODOS os dados
 * da aba OrderItems (sem janela de datas). Rode manualmente uma vez para popular
 * o histórico inicial da aba UpsellDaily.
 */
function syncUpsellFull() {
  const ss  = getSpreadsheet_();

  const itemsSh = ss.getSheetByName("OrderItems");
  if (!itemsSh) {
    Logger.log("syncUpsellFull: aba OrderItems não encontrada — rode syncOrdersAndItemsFull primeiro.");
    ss.toast("Erro: aba OrderItems não encontrada.", "Atenção", 5);
    return;
  }

  const itemValues = itemsSh.getDataRange().getValues();
  if (itemValues.length < 2) {
    ss.toast("OrderItems vazia — nada a processar.", "Atenção", 4);
    return;
  }

  const h          = itemValues[0].map(v => _normalizeHeader(v));
  const cOrderId   = h.findIndex(v => v === "order_id");
  const cDate      = h.findIndex(v => v === "order_created_at");
  const cType      = h.findIndex(v => v === "item_type");
  const cStatus    = h.findIndex(v => v === "order_status");

  if (cOrderId < 0 || cDate < 0 || cType < 0) {
    Logger.log("syncUpsellFull: colunas necessárias não encontradas. Headers: " + h.join(", "));
    ss.toast("Erro: colunas necessárias não encontradas em OrderItems.", "Atenção", 5);
    return;
  }

  // 1ª passagem: quais order_ids têm pelo menos 1 ADDON?
  const addonOrders = new Set();
  for (let i = 1; i < itemValues.length; i++) {
    if (String(itemValues[i][cType] || "").toUpperCase() === "ADDON") {
      addonOrders.add(String(itemValues[i][cOrderId] || ""));
    }
  }

  // 2ª passagem: conta distinct paid orders com addon, por dia — SEM filtro de janela
  const finalMap = new Map(); // "yyyy-MM-dd" → count
  const seen     = new Set();
  for (let i = 1; i < itemValues.length; i++) {
    const row     = itemValues[i];
    const orderId = String(row[cOrderId] || "");
    const status  = String(row[cStatus]  || "").toLowerCase();
    if (!addonOrders.has(orderId) || status !== "paid" || seen.has(orderId)) continue;
    seen.add(orderId);
    const dt = _parseDate(row[cDate]);
    if (!dt) continue;
    const key = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
    finalMap.set(key, (finalMap.get(key) || 0) + 1);
  }

  // Grava na aba UpsellDaily (substitui tudo)
  const dest = getOrCreateSheet_(UPSELL_SHEET);
  const keys = Array.from(finalMap.keys()).sort();
  const out  = keys.map(k => [new Date(k + "T12:00:00"), finalMap.get(k)]);

  dest.clearContents();
  dest.getRange(1, 1, 1, 2).setValues([["data", "pedidos_upsell"]]);
  if (out.length) {
    dest.getRange(2, 1, out.length, 2).setValues(out);
    dest.getRange(2, 1, out.length, 1).setNumberFormat("yyyy-mm-dd");
    dest.getRange(2, 2, out.length, 1).setNumberFormat("0");
  }
  dest.autoResizeColumns(1, 2);
  setConfigValue_("last_sync_upsell", new Date().toISOString());
  ss.toast("UpsellFull concluído: " + out.length + " dias de histórico.", "OK", 5);
  Logger.log("syncUpsellFull: " + out.length + " dias, " + addonOrders.size + " pedidos com addon.");
}

/**
 * syncUpsellByType — agrega upsell por tipo de addon e data.
 * Aba "UpsellByType": date | addon_key | label | count | revenue
 * count   = pedidos PAGOS distintos com esse addon naquela data
 * revenue = soma de total_amount dos itens desse tipo (em reais)
 * Roda a cada execução de syncAll (incremental — reescreve tudo a partir de OrderItems).
 */
function syncUpsellByType() {
  const ss = getSpreadsheet_();

  const itemsSh = ss.getSheetByName("OrderItems");
  if (!itemsSh) {
    Logger.log("syncUpsellByType: aba OrderItems não encontrada.");
    return;
  }

  const vals = itemsSh.getDataRange().getValues();
  if (vals.length < 2) return;

  const h        = vals[0].map(v => _normalizeHeader(v));
  const cOrderId = h.findIndex(v => v === "order_id");
  const cDate    = h.findIndex(v => v === "order_created_at");
  const cStatus  = h.findIndex(v => v === "order_status");
  const cType    = h.findIndex(v => v === "item_type");
  const cKey     = h.findIndex(v => v === "addon_key");
  const cDesc    = h.findIndex(v => v === "item_description");
  const cAmt     = h.findIndex(v => v === "total_amount");

  if (cOrderId < 0 || cDate < 0 || cType < 0 || cKey < 0) {
    Logger.log("syncUpsellByType: colunas necessárias não encontradas.");
    return;
  }

  // Map: "date|addon_key" → { label, orderIds: Set, revenue }
  const map = new Map();

  for (let i = 1; i < vals.length; i++) {
    const row    = vals[i];
    const type   = String(row[cType]   || "").toUpperCase();
    const status = String(row[cStatus] || "").toLowerCase();
    if ((type !== "ADDON" && type !== "BUNDLE") || status !== "paid") continue;

    const orderId  = String(row[cOrderId] || "");
    const addonKey = String(row[cKey]     || "") || "outro";
    const desc     = String(row[cDesc]    || "");
    const amt      = Number(row[cAmt]     || 0);
    const dt       = _parseDate(row[cDate]);
    if (!dt || !orderId) continue;

    const dateStr = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
    const mapKey  = dateStr + "|" + addonKey;

    if (!map.has(mapKey)) {
      map.set(mapKey, { date: dateStr, addonKey, label: _addonLabel_(addonKey, desc), orderIds: new Set(), revenue: 0 });
    }
    const entry = map.get(mapKey);
    entry.orderIds.add(orderId);
    entry.revenue += amt;
  }

  // Build rows sorted by date asc, then addon_key
  const rows = Array.from(map.values())
    .sort((a, b) => a.date.localeCompare(b.date) || a.addonKey.localeCompare(b.addonKey))
    .map(e => [new Date(e.date + "T12:00:00"), e.addonKey, e.label, e.orderIds.size, Math.round(e.revenue * 100) / 100]);

  const dest = getOrCreateSheet_(UPSELL_TYPE_SHEET);
  dest.clearContents();
  const headers = ["date", "addon_key", "label", "count", "revenue"];
  dest.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) {
    dest.getRange(2, 1, rows.length, headers.length).setValues(rows);
    dest.getRange(2, 1, rows.length, 1).setNumberFormat("yyyy-mm-dd");
    dest.getRange(2, 4, rows.length, 1).setNumberFormat("0");
    dest.getRange(2, 5, rows.length, 1).setNumberFormat("R$ #,##0.00");
  }
  dest.autoResizeColumns(1, headers.length);
  Logger.log("syncUpsellByType: " + rows.length + " linhas gravadas.");
}

/** Rótulo legível para um addon_key. */
function _addonLabel_(key, fallbackDesc) {
  const LABELS = {
    "dados_proprietario_atual": "Dados do Proprietário",
    "bin_estadual":             "Restrições Estaduais",
    "bin_federal":              "Restrições Federais",
    "gravame":                  "Gravame",
    "historico_leilao":         "Histórico de Leilão",
    "indicio_sinistro":         "Indício de Sinistro",
  };
  if (key.startsWith("combo:")) return "Pacote Completo";
  return LABELS[key] || fallbackDesc || key;
}

// ─────────────────────────────────────────────────────────────
//  ESCRITA — Orders (histórico preservado)
// ─────────────────────────────────────────────────────────────
function writeOrdersHistory_(orders) {
  const sh = getOrCreateSheet_("Orders");
  const headers = [
    "order_id", "code", "status", "amount", "currency",
    "customer_id", "items_count", "charges_count",
    "created_at", "updated_at"
  ];

  // Lê registros existentes
  const existing  = sh.getDataRange().getValues();
  const finalMap  = new Map();

  if (existing.length > 1) {
    for (let i = 1; i < existing.length; i++) {
      const row = existing[i];
      const id  = String(row[0] || "").trim();
      if (id) finalMap.set(id, row);
    }
  }

  // Sobrescreve / adiciona novos
  for (const o of orders) {
    const row = [
      o.id || "", o.code || "", o.status || "", num_(o.amount), o.currency || "",
      (o.customer && o.customer.id) ? o.customer.id : (o.customer_id || ""),
      Array.isArray(o.items)   ? o.items.length   : (o.items_count   || ""),
      Array.isArray(o.charges) ? o.charges.length : (o.charges_count || ""),
      o.created_at || "", o.updated_at || ""
    ];
    if (o.id) finalMap.set(o.id, row);
  }

  const rows = Array.from(finalMap.values())
    .sort((a, b) => String(a[8] || "").localeCompare(String(b[8] || "")));

  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.autoResizeColumns(1, headers.length);
}

// ─────────────────────────────────────────────────────────────
//  ESCRITA — OrderItems (carga completa — limpa e reescreve)
//  Usado por syncOrdersAndItemsFull() e na primeira carga.
// ─────────────────────────────────────────────────────────────
function writeOrderItemsFull_(orders) {
  const HEADERS = [
    "order_id","order_code","order_status","order_created_at",
    "customer_id","customer_email","customer_name","order_amount","currency",
    "item_id","item_code","item_description","qty","unit_amount","total_amount",
    "item_type","addon_key","addon_keys","addon_count"
  ];
  const rows = _buildOrderItemRows_(orders);
  const sh   = getOrCreateSheet_("OrderItems");
  sh.clearContents();
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
    _formatOrderItemSheet_(sh, 2, rows.length, HEADERS.length);
  }
  sh.autoResizeColumns(1, HEADERS.length);
}

// ─────────────────────────────────────────────────────────────
//  ESCRITA — OrderItems (incremental diário — apenas appenda)
//  Lê só a coluna order_id existente; appenda ordens novas.
//  Itens são imutáveis → se order_id já está na aba, pula.
// ─────────────────────────────────────────────────────────────
function writeOrderItemsAppend_(orders) {
  const HEADERS = [
    "order_id","order_code","order_status","order_created_at",
    "customer_id","customer_email","customer_name","order_amount","currency",
    "item_id","item_code","item_description","qty","unit_amount","total_amount",
    "item_type","addon_key","addon_keys","addon_count"
  ];
  const sh = getOrCreateSheet_("OrderItems");

  // Garante cabeçalho
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  }

  // Lê somente a coluna order_id (col 1) — muito mais rápido que ler tudo
  const lastRow = sh.getLastRow();
  const existingIds = new Set();
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, 1).getValues()
      .forEach(r => { if (r[0]) existingIds.add(String(r[0])); });
  }

  // Filtra apenas ordens ainda não presentes
  const newOrders = orders.filter(o => o.id && !existingIds.has(String(o.id)));
  if (!newOrders.length) {
    Logger.log("writeOrderItemsAppend_: nenhum item novo para adicionar.");
    return;
  }

  const rows = _buildOrderItemRows_(newOrders);
  if (!rows.length) return;

  const startRow = sh.getLastRow() + 1;
  sh.getRange(startRow, 1, rows.length, HEADERS.length).setValues(rows);
  _formatOrderItemSheet_(sh, startRow, rows.length, HEADERS.length);
  Logger.log("writeOrderItemsAppend_: " + rows.length + " itens adicionados (ordens novas: " + newOrders.length + ").");
}

// ─────────────────────────────────────────────────────────────
//  HELPER — constrói array de linhas para OrderItems
// ─────────────────────────────────────────────────────────────
function _buildOrderItemRows_(orders) {
  const rows = [];
  for (const o of orders) {
    const items = Array.isArray(o.items) ? o.items : [];
    if (!items.length) continue;
    for (const it of items) {
      const qty        = Number(it.quantity || 0);
      const unitCents  = Number(it.amount || 0);
      const totalCents = unitCents * qty;
      const itemCode   = String(it.code || "");
      const itemDesc   = String(it.description || it.name || "");
      const cls        = classifyItem_(itemCode, itemDesc);
      rows.push([
        o.id || "", o.code || "", o.status || "", o.created_at || "",
        (o.customer && o.customer.id)    ? o.customer.id    : (o.customer_id || ""),
        (o.customer && o.customer.email) ? o.customer.email : "",
        (o.customer && o.customer.name)  ? o.customer.name  : "",
        Number(o.amount || 0) / 100, o.currency || "",
        it.id || "", itemCode, itemDesc,
        qty || 0, unitCents / 100, totalCents / 100,
        cls.item_type, cls.addon_key,
        cls.addon_keys.join(","), cls.addon_count
      ]);
    }
  }
  return rows;
}

function _formatOrderItemSheet_(sh, startRow, numRows, numCols) {
  sh.getRange(startRow,  8, numRows, 1).setNumberFormat('R$ #,##0.00'); // order_amount
  sh.getRange(startRow, 14, numRows, 1).setNumberFormat('R$ #,##0.00'); // unit_amount
  sh.getRange(startRow, 15, numRows, 1).setNumberFormat('R$ #,##0.00'); // total_amount
  sh.getRange(startRow, 13, numRows, 1).setNumberFormat('0');           // qty
  sh.getRange(startRow, 19, numRows, 1).setNumberFormat('0');           // addon_count
}

// ─────────────────────────────────────────────────────────────
//  BACKOFFICE — Charges
// ─────────────────────────────────────────────────────────────
function syncCharges()     { _syncCharges(true);  } // compat: full
function _syncCharges(full) {
  const cfg    = getConfig_();
  const params = _backofficeParams_(cfg, full);
  const charges = fetchAllPaged_("/charges", params);
  const headers = [
    "charge_id","code","status","payment_method",
    "amount","paid_amount","currency",
    "customer_id","order_id","invoice_id",
    "created_at","updated_at"
  ];
  const rows = charges.map(c => [
    c.id||"",c.code||"",c.status||"",c.payment_method||"",
    num_(c.amount),num_(c.paid_amount),c.currency||"",
    (c.customer&&c.customer.id)?c.customer.id:(c.customer_id||""),
    c.order_id||(c.order&&c.order.id)||"",c.invoice_id||"",
    c.created_at||"",c.updated_at||""
  ]);
  if (full) clearAndWrite_("Charges", headers, rows);
  else      upsertHistory_("Charges", headers, rows);
}

// ─────────────────────────────────────────────────────────────
//  BACKOFFICE — Payables
// ─────────────────────────────────────────────────────────────
function syncPayables()     { _syncPayables(true);  } // compat: full
function _syncPayables(full) {
  const cfg    = getConfig_();
  const params = _backofficeParams_(cfg, full);
  if (cfg.recipient_id) params.recipient_id = cfg.recipient_id;
  const payables = fetchAllPaged_("/payables", params);
  const headers  = [
    "payable_id","type","status","recipient_id","payment_date",
    "amount","fee","anticipation_fee","fraud_coverage_fee",
    "net_amount_calc","installment","gateway_id",
    "liquidation_arrangement_id","created_at"
  ];
  const rows = payables.map(p => {
    const amount = num_(p.amount), fee = num_(p.fee),
          ant    = num_(p.anticipation_fee), fraud = num_(p.fraud_coverage_fee);
    return [
      p.id||"",p.type||"",p.status||"",p.recipient_id||"",
      p.payment_date||"",amount,fee,ant,fraud,amount-fee-ant-fraud,
      p.installment||"",p.gateway_id||"",
      p.liquidation_arrangement_id||"",p.created_at||""
    ];
  });
  if (full) clearAndWrite_("Payables", headers, rows);
  else      upsertHistory_("Payables", headers, rows);
  setConfigValue_("last_sync_payables", new Date().toISOString());
}

// ─────────────────────────────────────────────────────────────
//  BACKOFFICE — Settlements
// ─────────────────────────────────────────────────────────────
function syncSettlements()     { _syncSettlements(true);  } // compat: full
function _syncSettlements(full) {
  const cfg = getConfig_();

  // Settlements usam payment_date (não created_at) como filtro
  let paymentStart, paymentEnd;
  if (full) {
    paymentStart = _toDateOnly(cfg.created_since);
    paymentEnd   = _toDateOnly(cfg.created_until);
    if (!paymentStart || !paymentEnd)
      throw new Error('Preencha "created_since" e "created_until" na Config.');
  } else {
    const hours = Math.max(parseInt(cfg.backoffice_lookback_hours || "48", 10) || 48, 1);
    const now   = new Date();
    paymentStart = _toDateOnly(new Date(now.getTime() - hours * 3600 * 1000).toISOString());
    paymentEnd   = _toDateOnly(now.toISOString());
  }

  const params = {
    page: 1, size: cfg.page_size,
    payment_date_start: paymentStart,
    payment_date_end:   paymentEnd
  };

  const endpointByRecipient = cfg.recipient_id
    ? `/recipients/${encodeURIComponent(cfg.recipient_id)}/settlements`
    : null;

  let settlements = [];
  if (endpointByRecipient) {
    try { settlements = fetchAllPaged_(endpointByRecipient, params); }
    catch (e) {
      if (String(e).includes("HTTP 403")) {
        setLastError_("settlements por recipient bloqueado (403) — usando /settlements global.");
        settlements = fetchAllPaged_("/settlements", params);
      } else throw e;
    }
  } else {
    settlements = fetchAllPaged_("/settlements", params);
  }

  const headers = [
    "settlement_id","status","product","amount","payment_date",
    "recipient_id","liquidation_arrangement_id","liquidation_type",
    "card_brand","created_at"
  ];
  const rows = settlements.map(s => [
    s.id||"",s.status||"",s.product||"",num_(s.amount),s.payment_date||"",
    s.recipient_id||cfg.recipient_id||"",
    s.liquidation_arrangement_id||"",s.liquidation_type||"",
    s.card_brand||"",s.created_at||""
  ]);
  if (full) clearAndWrite_("Settlements", headers, rows);
  else      upsertHistory_("Settlements", headers, rows);
  setConfigValue_("last_sync_settlements", new Date().toISOString());
}

// ─────────────────────────────────────────────────────────────
//  BACKOFFICE — Balance Operations
// ─────────────────────────────────────────────────────────────
function syncBalanceOperations()     { _syncBalanceOperations(true);  } // compat: full
function _syncBalanceOperations(full) {
  const cfg    = getConfig_();
  const params = _backofficeParams_(cfg, full);
  const ops    = fetchAllPaged_("/balance/operations", params);
  const headers = [
    "operation_id","type","amount","status",
    "created_at","recipient_id","object_id"
  ];
  const rows = ops.map(o => [
    o.id||"",o.type||"",num_(o.amount),o.status||"",
    o.created_at||"",o.recipient_id||"",o.object_id||""
  ]);
  if (full) clearAndWrite_("BalanceOperations", headers, rows);
  else      upsertHistory_("BalanceOperations", headers, rows);
}

// ─────────────────────────────────────────────────────────────
//  BACKOFFICE — Recipients
// ─────────────────────────────────────────────────────────────
function syncRecipients() {
  const cfg = getConfig_();
  const params = { page: 1, size: cfg.page_size || 50 };
  const recipients = fetchAllPaged_("/recipients", params);
  const headers = ["recipient_id","name","email","status","created_at"];
  const rows = recipients.map(r => [r.id||"",r.name||"",r.email||"",r.status||"",r.created_at||""]);
  clearAndWrite_("Recipients", headers, rows);
}

// ─────────────────────────────────────────────────────────────
//  BACKOFFICE — Recipient Balance
// ─────────────────────────────────────────────────────────────
function syncRecipientBalance() {
  const cfg = getConfig_();
  if (!cfg.recipient_id) throw new Error('Preencha "recipient_id" na Config.');
  const url  = `${PAGARME_BASE}/recipients/${encodeURIComponent(cfg.recipient_id)}/balance`;
  const json = fetchJson_(url);
  clearAndWrite_("RecipientBalance",
    ["recipient_id","raw_json","fetched_at"],
    [[cfg.recipient_id, JSON.stringify(json), new Date().toISOString()]]
  );
}

// ─────────────────────────────────────────────────────────────
//  CLASSIFICAÇÃO DE ITENS
// ─────────────────────────────────────────────────────────────
function classifyItem_(itemCode, itemDesc) {
  const code  = String(itemCode || "").trim().toLowerCase();
  const descN = _normalizeText(itemDesc);

  if (code.startsWith("addon_")) {
    const parsed     = _parseAddonKeys(code);
    const item_type  = parsed.is_combo ? "BUNDLE" : "ADDON";
    const addon_keys = parsed.addon_keys;
    const addon_key  = parsed.is_combo
      ? "combo:" + addon_keys.join("+")
      : (addon_keys[0] || "");
    return { item_type, addon_key, addon_keys, addon_count: addon_keys.length };
  }

  if (descN.includes("blindagem completa")) {
    const addon_keys = [
      "bin_estadual","bin_federal","gravame","historico_leilao",
      "indicio_sinistro","dados_proprietario_atual"
    ];
    return {
      item_type: "BUNDLE",
      addon_key: "combo:" + addon_keys.join("+"),
      addon_keys, addon_count: addon_keys.length
    };
  }

  if (descN.includes("dados do proprietario") || descN.includes("proprietario atual")) {
    return { item_type:"ADDON", addon_key:"dados_proprietario_atual",
             addon_keys:["dados_proprietario_atual"], addon_count:1 };
  }

  return { item_type:"OUTRO", addon_key:"", addon_keys:[], addon_count:0 };
}

function _parseAddonKeys(code) {
  const rest     = code.replace(/^addon_/, "");
  const lastIdx  = rest.lastIndexOf("_");
  const keysPart = lastIdx >= 0 ? rest.substring(0, lastIdx) : rest;
  const addon_keys = keysPart.split("+")
    .map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/[^a-z0-9_]/g, "")).filter(Boolean);
  return { addon_keys, is_combo: addon_keys.length > 1 };
}

// ─────────────────────────────────────────────────────────────
//  TRIGGERS AUTOMÁTICOS
// ─────────────────────────────────────────────────────────────
function setupAutoSync() {
  // Remove todos os triggers antigos gerenciados por este script
  const MANAGED = ["syncAll","syncBackoffice","syncRevenueDailyFromOrdersSheet",
                   "syncUpsellDaily","syncDashboard","syncBureauFromSupabase"];
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction ? t.getHandlerFunction() : "";
    if (MANAGED.includes(fn)) ScriptApp.deleteTrigger(t);
  });

  // ① Orders + OrderItems + RevenueDaily + UpsellByType — a cada 1 hora
  ScriptApp.newTrigger("syncAll")
    .timeBased()
    .everyHours(1)
    .create();

  // ② Backoffice (Charges, Payables, Settlements…) — 1x por dia às 6h10
  ScriptApp.newTrigger("syncBackoffice")
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .nearMinute(10)
    .create();

  // ③ Bureau do Supabase — 3x por dia: 7h, 13h, 20h
  [7, 13, 20].forEach(hour => {
    ScriptApp.newTrigger("syncBureauFromSupabase")
      .timeBased()
      .everyDays(1)
      .atHour(hour)
      .create();
  });

  // ④ Dashboard (consolida GAds + Pagar.me) — a cada 30 minutos
  //    Garante que dados do Google Ads report (atualizado pelo add-on) sejam
  //    incorporados ao CSV do dashboard frequentemente ao longo do dia.
  ScriptApp.newTrigger("syncDashboard")
    .timeBased()
    .everyMinutes(30)
    .create();

  SpreadsheetApp.getActiveSpreadsheet()
    .toast("Triggers OK: syncAll 1h · syncBackoffice 6h10 · Bureau 3x/dia · Dashboard a cada 30min", "Triggers OK", 8);
}

// ─────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────
function getConfig_() {
  const sh     = getOrCreateSheet_(CONFIG_SHEET);
  const values = sh.getDataRange().getValues();
  const map    = {};

  for (let i = 1; i < values.length; i++) {
    const key = String(values[i][0] || "").trim();
    const val = String(values[i][1] || "").trim();
    if (key) map[key] = val;
  }

  // Defaults
  const pageSize = parseInt(map.page_size || "50", 10);
  map.page_size               = (Number.isFinite(pageSize) && pageSize>0 && pageSize<=100) ? String(pageSize) : "50";
  map.created_since           = map.created_since           || "";
  map.created_until           = map.created_until           || "";
  map.recipient_id            = map.recipient_id            || "";
  map.orderitems_lookback_hours    = map.orderitems_lookback_hours    || "24";
  map.backoffice_lookback_hours    = map.backoffice_lookback_hours    || "48";
  map.paid_statuses           = map.paid_statuses           || "paid";
  map.lookback_days           = map.lookback_days           || "0";
  map.source_orders_sheet     = map.source_orders_sheet     || "Orders";

  return map;
}

function setConfigValue_(key, value) {
  const sh      = getOrCreateSheet_(CONFIG_SHEET);
  const lastRow = sh.getLastRow();
  const data    = lastRow ? sh.getRange(1, 1, lastRow, 2).getValues() : [];

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || "").trim() === key) {
      sh.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sh.getRange(Math.max(2, lastRow + 1), 1, 1, 2).setValues([[key, value]]);
}

function setLastError_(msg) {
  try { setConfigValue_("last_error", msg || ""); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
//  SPREADSHEET HELPERS
// ─────────────────────────────────────────────────────────────

// Cache da instância — openById é chamado apenas 1x por execução
let _ssCache = null;

function getSpreadsheet_() {
  if (_ssCache) return _ssCache;

  const ssid = PropertiesService.getScriptProperties().getProperty(PROP_SSID);
  if (ssid) {
    _ssCache = SpreadsheetApp.openById(ssid);
    return _ssCache;
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    PropertiesService.getScriptProperties().setProperty(PROP_SSID, active.getId());
    _ssCache = active;
    return _ssCache;
  }
  throw new Error("SPREADSHEET_ID não configurado. Rode setupSpreadsheetId() com a planilha aberta.");
}

function getOrCreateSheet_(name) {
  const ss = getSpreadsheet_();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function clearAndWrite_(sheetName, headers, rows) {
  const sh = getOrCreateSheet_(sheetName);
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.autoResizeColumns(1, headers.length);
}

/**
 * upsertHistory_ — lê registros existentes (col 0 = ID), faz upsert em memória
 * e reescreve a aba inteira. Ideal para dados mutáveis (status pode mudar).
 * Mantém histórico completo; o sync diário atualiza apenas o que mudou.
 */
function upsertHistory_(sheetName, headers, newRows) {
  const sh       = getOrCreateSheet_(sheetName);
  const existing = sh.getDataRange().getValues();
  const finalMap = new Map();

  // Carrega histórico existente
  if (existing.length > 1) {
    for (let i = 1; i < existing.length; i++) {
      const id = String(existing[i][0] || "").trim();
      if (id) finalMap.set(id, existing[i]);
    }
  }

  // Upsert: sobrescreve / adiciona
  for (const row of newRows) {
    const id = String(row[0] || "").trim();
    if (id) finalMap.set(id, row);
  }

  const rows = Array.from(finalMap.values());
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.autoResizeColumns(1, headers.length);
  Logger.log("upsertHistory_(" + sheetName + "): " + rows.length + " registros totais (" + newRows.length + " novos/atualizados).");
}

/**
 * _backofficeParams_ — monta params de data para funções de backoffice.
 * full=true  → usa created_since/created_until da Config (carga completa)
 * full=false → usa janela de backoffice_lookback_hours (padrão 48h)
 */
function _backofficeParams_(cfg, full) {
  const params = { page: 1, size: cfg.page_size };
  if (full) {
    if (cfg.created_since) params.created_since = cfg.created_since;
    if (cfg.created_until) params.created_until = cfg.created_until;
  } else {
    const hours = Math.max(parseInt(cfg.backoffice_lookback_hours || "48", 10) || 48, 1);
    const now   = new Date();
    params.created_since = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
    params.created_until = now.toISOString();
  }
  return params;
}

// ─────────────────────────────────────────────────────────────
//  HTTP / AUTH
// ─────────────────────────────────────────────────────────────
function getSecretKey_() {
  const key = PropertiesService.getScriptProperties().getProperty(PROP_SECRET);
  if (!key) throw new Error("SecretKey não configurada. Defina Script Properties: PAGARME_SECRET_KEY");
  return key;
}

function authHeader_() {
  return {
    Authorization: "Basic " + Utilities.base64Encode(getSecretKey_() + ":"),
    Accept: "application/json"
  };
}

function fetchJson_(url) {
  const resp = UrlFetchApp.fetch(url, {
    method: "get",
    headers: authHeader_(),
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300)
    throw new Error(`HTTP ${code} → ${url}\n${text}`);
  return JSON.parse(text);
}

function buildUrl_(endpointOrUrl, params) {
  const base = endpointOrUrl.startsWith("http")
    ? endpointOrUrl
    : PAGARME_BASE + endpointOrUrl;
  const q = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `${base}?${q}` : base;
}

function fetchAllPaged_(endpointOrUrl, params) {
  let url = buildUrl_(endpointOrUrl, params);
  const out = [];
  while (url) {
    const json = fetchJson_(url);
    if (Array.isArray(json.data)) out.push(...json.data);
    url = (json.paging && json.paging.next) ? json.paging.next : null;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
//  UTILITÁRIOS
// ─────────────────────────────────────────────────────────────
function num_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function _toDateOnly(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function _parseDate(v) {
  if (v instanceof Date) return v;
  const s = String(v || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function _normalizeHeader(h) {
  return String(h || "").trim().toLowerCase()
    .replace(/\s+/g, "_").replace(/[^\w_]/g, "");
}

function _normalizeText(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────
//  BUREAU — Supabase → BureauDaily
// ─────────────────────────────────────────────────────────────

/**
 * syncBureauFromSupabase — chama a RPC get_bureau_costs_daily() no Supabase
 * e grava os resultados na aba "BureauDaily".
 *
 * Script Properties necessárias (Editor → Propriedades do projeto):
 *   SUPABASE_URL      → https://SEU_PROJETO.supabase.co
 *   SUPABASE_ANON_KEY → chave anon (ou service_role) do projeto
 *
 * Pré-requisito: criar a função SQL get_bureau_costs_daily() no Supabase
 * (ver instruções em pagarme-unified.js ou documentação do projeto).
 */
function syncBureauFromSupabase() {
  const props     = PropertiesService.getScriptProperties();
  const sbUrl     = (props.getProperty(PROP_SB_URL)  || "").replace(/\/$/, "");
  const sbKey     = props.getProperty(PROP_SB_KEY)   || "";

  if (!sbUrl || !sbKey) {
    throw new Error(
      "Configure SUPABASE_URL e SUPABASE_ANON_KEY nas Script Properties " +
      "(Editor → Propriedades do projeto)."
    );
  }

  const url  = sbUrl + "/rest/v1/rpc/get_bureau_costs_daily";
  const resp = UrlFetchApp.fetch(url, {
    method:           "post",
    headers: {
      "Content-Type":  "application/json",
      "apikey":         sbKey,
      "Authorization":  "Bearer " + sbKey
    },
    payload:          JSON.stringify({}),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const body = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error("Supabase HTTP " + code + " → " + url + "\n" + body);
  }

  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) throw new Error("Resposta inesperada do Supabase: " + body.slice(0,200));

  const ss      = getSpreadsheet_();
  const sh      = getOrCreateSheet_(BUREAU_SHEET);
  const headers = ["dia", "vendas_pagas", "vendido_real", "custo_bureau", "lucro_bruto"];

  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (rows.length) {
    const data = rows.map(r => [
      new Date(String(r.dia) + "T12:00:00"), // Date object, meio-dia evita virada de fuso
      Number(r.vendas_pagas   || 0),
      Number(r.vendido_real   || 0),
      Number(r.custo_bureau   || 0),
      Number(r.lucro_bruto    || 0)
    ]);
    sh.getRange(2, 1, data.length, headers.length).setValues(data);
    sh.getRange(2, 1, data.length, 1).setNumberFormat("yyyy-mm-dd");
    sh.getRange(2, 2, data.length, 1).setNumberFormat("0");
    sh.getRange(2, 3, data.length, 3).setNumberFormat("R$ #,##0.00");
  }

  sh.autoResizeColumns(1, headers.length);
  setConfigValue_("last_sync_bureau", new Date().toISOString());
  setConfigValue_("last_error", "");
  ss.toast("BureauDaily atualizado: " + rows.length + " dias.", "OK", 4);
}

// ─────────────────────────────────────────────────────────────
//  DASHBOARD — Consolidação de todas as fontes de dados
// ─────────────────────────────────────────────────────────────
const DASHBOARD_SHEET = "Dashboard";

/**
 * syncDashboard — consolida GAds_Diario, GAds_Conversoes,
 * RevenueDaily e OrderItems em uma única aba "Dashboard".
 *
 * Colunas de saída:
 *   data | custo_ads | receita | pedidos | checkouts | compras
 *   cac  | roas      | margem_pct | pedidos_upsell | tx_upsell_pct
 *
 * Chamado automaticamente ao final de syncAll (trigger horário).
 * Preserva dados de upsell históricos (OrderItems é janela recente).
 */
/**
 * syncDashboard — consolida GAds + Pagar.me + Supabase Bureau em "Dashboard".
 *
 * Colunas de saída:
 *   data | custo_ads | custo_bureau | custo_total | receita
 *   pedidos | checkouts | compras | lucro | cac | roas
 *   margem_pct | pedidos_upsell | tx_upsell_pct
 *
 * lucro        = receita − custo_ads − custo_bureau
 * margem_pct   = lucro / receita × 100
 * cac          = custo_ads / compras  (custo de aquisição via Ads)
 * roas         = receita / custo_ads
 */
function syncDashboard() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log("syncDashboard: outra execução em andamento. Pulando.");
    return;
  }
  const ss = getSpreadsheet_();
  try {
    const gadsDaily = _readGAdsDaily_(ss);
    const gadsConv  = _readGAdsConversoes_(ss);
    const revDaily  = _readRevDaily_(ss);
    const bureauMap = _readBureauDaily_(ss);
    const upsellMap = _readUpsellDaily_(ss);  // ← lê UpsellDaily (histórico permanente)

    const dest = getOrCreateSheet_(DASHBOARD_SHEET);

    // Reúne todas as datas conhecidas
    const allKeys = new Set([
      ...gadsDaily.keys(), ...gadsConv.keys(), ...revDaily.keys(), ...bureauMap.keys()
    ]);

    const headers = [
      "data", "custo_ads", "custo_bureau", "custo_total", "receita",
      "pedidos", "checkouts", "compras",
      "lucro", "cac", "roas", "margem_pct",
      "pedidos_upsell", "tx_upsell_pct"
    ];

    const rows = Array.from(allKeys).sort().map(key => {
      const ads    = gadsDaily.get(key)  || { cost: 0 };
      const conv   = gadsConv.get(key)   || { checkouts: 0, purchases: 0 };
      const rev    = revDaily.get(key)   || { revenue: 0, orders: 0 };
      const bureau = bureauMap.get(key)  || { custo: 0 };

      const custoAds    = ads.cost;
      const custoBureau = bureau.custo;
      const custoTotal  = +(custoAds + custoBureau).toFixed(2);
      const receita     = rev.revenue;
      const pedidos     = rev.orders;
      const checkouts   = conv.checkouts;
      const compras     = conv.purchases;

      const lucro  = +(receita - custoTotal).toFixed(2);
      const cac    = compras > 0 ? +(custoAds / compras).toFixed(2) : "";  // CAC = só Ads
      const roas   = custoAds > 0 ? +(receita / custoAds).toFixed(4) : ""; // ROAS = só Ads
      const margem = receita  > 0 ? +(lucro / receita * 100).toFixed(2) : "";

      const upsellOrd = upsellMap.get(key) || 0;
      const txUpsell  = pedidos > 0 && upsellOrd > 0
        ? +(upsellOrd / pedidos * 100).toFixed(2) : "";

      return [
        new Date(key + "T00:00:00"),
        custoAds, custoBureau, custoTotal, receita,
        pedidos, checkouts, compras,
        lucro, cac, roas, margem,
        upsellOrd || "", txUpsell
      ];
    });

    dest.clearContents();
    dest.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (rows.length) {
      dest.getRange(2, 1, rows.length, headers.length).setValues(rows);
      dest.getRange(2,  1, rows.length, 1).setNumberFormat("yyyy-mm-dd");   // data
      dest.getRange(2,  2, rows.length, 4).setNumberFormat("R$ #,##0.00");  // custo_ads..receita
      dest.getRange(2,  6, rows.length, 1).setNumberFormat("0");            // pedidos
      dest.getRange(2,  7, rows.length, 2).setNumberFormat("0");            // checkouts, compras
      dest.getRange(2,  9, rows.length, 1).setNumberFormat("R$ #,##0.00");  // lucro
      dest.getRange(2, 10, rows.length, 1).setNumberFormat("R$ #,##0.00");  // cac
      dest.getRange(2, 11, rows.length, 1).setNumberFormat("0.00");         // roas
      dest.getRange(2, 12, rows.length, 1).setNumberFormat("0.00");         // margem_pct
      dest.getRange(2, 13, rows.length, 1).setNumberFormat("0");            // pedidos_upsell
      dest.getRange(2, 14, rows.length, 1).setNumberFormat("0.00");         // tx_upsell_pct
    }
    dest.autoResizeColumns(1, headers.length);
    setConfigValue_("last_sync_dashboard", new Date().toISOString());
    setConfigValue_("last_error", "");
    ss.toast("Dashboard atualizado: " + rows.length + " dias.", "OK", 4);

  } catch (err) {
    const msg = (err && err.stack) ? err.stack : String(err);
    setLastError_(msg);
    throw err;
  } finally {
    lock.releaseLock();
    _ssCache = null;
  }
}

// ── Helpers do Dashboard ──────────────────────────────────────

/** Map<"yyyy-MM-dd", { cost }> — somas diárias do GAds_Diario. */
function _readGAdsDaily_(ss) {
  const result = new Map();

  // ── Lê histórico do report diário (GAds_Diario) ──────────────────────────
  // Suporta exports do add-on em PT ("Data","Dia","Custo","Custo total") e EN ("Day","Date","Cost")
  const sh = ss.getSheetByName("GAds_Diario");
  if (sh) {
    const values = sh.getDataRange().getValues();
    if (values.length >= 2) {
      let headerIdx = -1;
      for (let r = 0; r < Math.min(6, values.length); r++) {
        const row = values[r].map(h => _normGAds_(h));
        const isDateCol = h => h === "dia" || h === "day" || h === "data" || h === "date";
        if (row.some(isDateCol)) { headerIdx = r; break; }
      }
      if (headerIdx < 0) {
        Logger.log("GAds_Diario: coluna de data não encontrada nas primeiras 6 linhas. Headers linha 0: " +
          values[0].join(" | "));
      } else {
        const header = values[headerIdx].map(h => _normGAds_(h));
        const isDateCol = h => h === "dia" || h === "day" || h === "data" || h === "date";
        const isCostCol = h => h === "custo" || h === "cost" || h === "custo_total" ||
                               h === "custo_com_conv_" || h.startsWith("custo") && !h.includes("bureau");
        const cDay  = header.findIndex(isDateCol);
        const cCost = header.findIndex(isCostCol);
        Logger.log("GAds_Diario: headerIdx=" + headerIdx + " cDay=" + cDay + " cCost=" + cCost +
                   " headers=" + header.join("|"));
        if (cDay >= 0 && cCost >= 0) {
          for (let i = headerIdx + 1; i < values.length; i++) {
            const row = values[i];
            const rawDay = row[cDay];
            const dayStr = (rawDay instanceof Date)
              ? Utilities.formatDate(rawDay, TZ, "yyyy-MM-dd")
              : String(rawDay || "").trim();
            if (!dayStr || /total|subtotal/i.test(dayStr)) continue;
            const key  = _normalizeGAdsDate_(dayStr);
            if (!key) continue;
            const cost = _parseGAdsNum_(row[cCost]);
            if (cost > 50000) { Logger.log("GAds_Diario: valor suspeito linha " + (i+1) + " → " + cost); continue; }
            result.set(key, { cost: ((result.get(key) || {}).cost || 0) + cost });
          }
          Logger.log("GAds_Diario: " + result.size + " dias lidos, custo total = R$" +
            Array.from(result.values()).reduce((s,v)=>s+v.cost,0).toFixed(2));
        } else {
          Logger.log("GAds_Diario: colunas não encontradas. Headers: " + header.join(" | "));
        }
      }
    }
  } else {
    Logger.log('Aba "GAds_Diario" não encontrada.');
  }

  // ── Lê histórico acumulado pelo Google Ads Script (GAds_Historico) ──────────
  // Mesma estrutura que GAds_Hoje mas com 1 linha por dia (nunca sobrescreve).
  // Tem prioridade sobre GAds_Diario (add-on) para todos os dias.
  const shHist = ss.getSheetByName("GAds_Historico");
  if (shHist) {
    const vals = shHist.getDataRange().getValues();
    if (vals.length >= 2) {
      const hdr   = vals[0].map(h => _normGAds_(h));
      const cDate = hdr.findIndex(h => h === "data" || h === "dia");
      const cCost = hdr.findIndex(h => h === "custo" || h === "cost");
      if (cDate >= 0 && cCost >= 0) {
        for (let i = 1; i < vals.length; i++) {
          const raw = vals[i][cDate];
          const isDateObj = raw instanceof Date;
          // Sheets converte strings "yyyy-MM-dd" para meia-noite UTC (T00:00:00.000Z).
          // Formatar com TZ (São Paulo, UTC-3) resultaria em "dia anterior". Usar UTC.
          const dateStr = isDateObj
            ? Utilities.formatDate(raw, "UTC", "yyyy-MM-dd")
            : _normalizeGAdsDate_(String(raw || "").trim());
          if (!dateStr) continue;
          const cost = _parseGAdsNum_(vals[i][cCost]);
          result.set(dateStr, { cost });
        }
        const histTotal = Array.from(result.values()).reduce((s,v)=>s+v.cost,0);
        Logger.log("GAds_Historico: " + (vals.length - 1) + " dias, custo total = R$" + histTotal.toFixed(2));
        Logger.log("GAds_Historico: tem 2026-03-31? " + result.has("2026-03-31") +
                   " → cost=" + (result.get("2026-03-31") ? result.get("2026-03-31").cost : "N/A"));
      } else {
        Logger.log("GAds_Historico: colunas date/cost não encontradas. Headers: " + vals[0].join(" | "));
      }
    }
  }

  // ── Sobrescreve HOJE com dados intraday do Google Ads Script (GAds_Hoje) ──
  // A aba GAds_Hoje é gravada pelo script externo a cada hora e tem prioridade
  // sobre qualquer outra fonte para a data corrente.
  const shHoje = ss.getSheetByName("GAds_Hoje");
  if (shHoje) {
    const vals = shHoje.getDataRange().getValues();
    // Linha 1 = headers, Linha 2 = resumo do dia (data | custo | ...)
    if (vals.length >= 2) {
      const hdr    = vals[0].map(h => _normGAds_(h));
      const cDate  = hdr.findIndex(h => h === "data"  || h === "dia");
      const cCosto = hdr.findIndex(h => h === "custo" || h === "cost");
      if (cDate >= 0 && cCosto >= 0) {
        const row  = vals[1];
        const raw  = row[cDate];
        // raw pode ser Date (Sheets auto-converte) ou string "yyyy-MM-dd"
        const isDateObj = raw instanceof Date;
        // Mesmo fix: Sheets armazena string como meia-noite UTC → formatar em UTC.
        const dateStr = isDateObj
          ? Utilities.formatDate(raw, "UTC", "yyyy-MM-dd")
          : _normalizeGAdsDate_(String(raw || "").trim());
        const cost = _parseGAdsNum_(row[cCosto]);
        if (dateStr && cost >= 0) {
          result.set(dateStr, { cost });
          Logger.log("GAds_Hoje: sobreposição para " + dateStr + " → R$" + cost);
        }
      }
    }
  }

  return result;
}

/**
 * Map<"yyyy-MM-dd", { checkouts, purchases }> — do GAds_Conversoes.
 * Filtra: apenas begin_checkout e purchase onde Conv. value > 0.
 */
function _readGAdsConversoes_(ss) {
  const result = new Map();
  const sh = ss.getSheetByName("GAds_Conversoes");
  if (!sh) { Logger.log('Aba "GAds_Conversoes" não encontrada.'); return result; }

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return result;

  // Auto-detect linha de cabeçalho
  let headerIdx = -1;
  for (let r = 0; r < Math.min(5, values.length); r++) {
    const row = values[r].map(h => _normGAds_(h));
    if (row.some(h => h === "dia" || h === "day")) { headerIdx = r; break; }
  }
  if (headerIdx < 0) {
    Logger.log("GAds_Conversoes: coluna Dia/Day não encontrada nas primeiras 5 linhas.");
    return result;
  }

  const header  = values[headerIdx].map(h => _normGAds_(h));
  const cDay    = header.findIndex(h => h === "dia"  || h === "day");
  const cAction = header.findIndex(h =>
    h.includes("acao") || h.includes("accao") || h.includes("action") ||
    h.includes("conversao") || h.includes("conversion_action") || h.includes("nome_da_acao")
  );
  const cConvs  = header.findIndex(h =>
    h === "conversoes" || h === "conversions" || h === "conv" ||
    h === "conversoes_" || h === "conv_"
  );
  const cVal    = header.findIndex(h =>
    h === "valor_conv" || h === "valor_de_conv" || h === "conversion_value" ||
    h.includes("valor_conv") || h.includes("conv_value")
  );

  // Log completo dos headers para diagnóstico
  Logger.log("GAds_Conversoes headers (norm): " + header.join(" | "));
  Logger.log("GAds_Conversoes cDay=" + cDay + " cAction=" + cAction + " cConvs=" + cConvs + " cVal=" + cVal);

  if (cDay < 0 || cConvs < 0) {
    Logger.log("GAds_Conversoes: colunas necessárias não encontradas.");
    return result;
  }

  // Log das primeiras 3 linhas de dados para diagnóstico
  for (let d = headerIdx + 1; d < Math.min(headerIdx + 4, values.length); d++) {
    Logger.log("GAds_Conversoes linha " + (d+1) + ": " + values[d].slice(0, 6).join(" | "));
  }

  for (let i = headerIdx + 1; i < values.length; i++) {
    const row    = values[i];
    const dayStr = String(row[cDay] || "").trim();
    if (!dayStr || /total|subtotal/i.test(dayStr)) continue;

    const action = cAction >= 0 ? _normGAds_(row[cAction]) : "";
    const convs  = _parseGAdsNum_(row[cConvs]);
    const val    = cVal >= 0 ? _parseGAdsNum_(row[cVal]) : 1;

    if (convs <= 0) continue;

    const key = _normalizeGAdsDate_(dayStr);
    if (!key) continue;

    if (!result.has(key)) result.set(key, { checkouts: 0, purchases: 0 });
    const entry = result.get(key);

    if (action.includes("checkout")) {
      // begin_checkout tem conv_value = 0 por design — NÃO filtrar por val
      entry.checkouts += convs;
    } else if (action.includes("purchase") || action.includes("compra")) {
      // purchase: filtra duplicata server-side (conv_value = 0 = tag sem pixel)
      if (cVal >= 0 && val <= 0) continue;
      entry.purchases += convs;
    } else {
      Logger.log("GAds_Conversoes: ação não mapeada → '" + action + "' (" + String(row[cAction] || "") + ")");
    }
  }
  return result;
}

/** Map<"yyyy-MM-dd", { custo }> — do BureauDaily (Supabase). */
function _readBureauDaily_(ss) {
  const result = new Map();
  const sh = ss.getSheetByName(BUREAU_SHEET);
  if (!sh) return result; // aba ainda não existe → bureau = 0 em todas as datas

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return result;

  const header  = values[0].map(h => _normalizeHeader(h));
  const cDate   = header.findIndex(h => h === "dia"  || h === "data" || h === "date");
  const cCusto  = header.findIndex(h => h === "custo_bureau" || h === "custo" || h === "total_custo_consultas");

  if (cDate < 0) return result;
  const custoIdx = cCusto >= 0 ? cCusto : 3; // col 3 = custo_bureau por padrão

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const dt  = row[cDate];
    if (!dt) continue;
    let key;
    if (dt instanceof Date) {
      key = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
    } else {
      const d = new Date(String(dt) + "T00:00:00");
      if (isNaN(d.getTime())) continue;
      key = Utilities.formatDate(d, TZ, "yyyy-MM-dd");
    }
    result.set(key, { custo: Number(row[custoIdx] || 0) });
  }
  return result;
}

/** Map<"yyyy-MM-dd", { revenue, orders }> — do RevenueDaily. */
function _readRevDaily_(ss) {
  const result = new Map();
  const sh = ss.getSheetByName(REVENUE_SHEET);
  if (!sh) return result;

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return result;

  const header    = values[0].map(h => _normalizeHeader(h));
  const cDate     = header.findIndex(h => h === "data" || h === "date");
  const cRev      = header.findIndex(h => h === "receita_bruta" || h === "receita");
  const cOrders   = header.findIndex(h => h === "pedidos_pagos" || h === "pedidos" || h === "orders");
  const revIdx    = cRev    >= 0 ? cRev    : 1;
  const ordersIdx = cOrders >= 0 ? cOrders : 3;

  if (cDate < 0) return result;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const dt  = row[cDate];
    if (!dt) continue;
    let key;
    if (dt instanceof Date) {
      key = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
    } else {
      const d = new Date(String(dt));
      if (isNaN(d.getTime())) continue;
      key = Utilities.formatDate(d, TZ, "yyyy-MM-dd");
    }
    result.set(key, {
      revenue: Number(row[revIdx]    || 0),
      orders:  Number(row[ordersIdx] || 0)
    });
  }
  return result;
}

/**
 * Map<"yyyy-MM-dd", number> — pedidos com ADDON por dia.
 * Baseado na aba OrderItems (janela recente); o Dashboard preserva
 * dados históricos via prevUpsell.
 */
function _readUpsellFromOrderItems_(ss) {
  const result = new Map();
  const sh = ss.getSheetByName("OrderItems");
  if (!sh) return result;

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return result;

  const header   = values[0].map(h => _normalizeHeader(h));
  const cOrderId = header.findIndex(h => h === "order_id");
  const cDate    = header.findIndex(h => h === "order_created_at");
  const cType    = header.findIndex(h => h === "item_type");
  const cStatus  = header.findIndex(h => h === "order_status");

  if (cOrderId < 0 || cDate < 0 || cType < 0) return result;

  // 1ª passagem: quais order_ids têm pelo menos 1 item ADDON?
  const addonOrders = new Set();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][cType] || "").toUpperCase() === "ADDON") {
      addonOrders.add(String(values[i][cOrderId] || ""));
    }
  }

  // 2ª passagem: data do pedido (distinct, status paid)
  const seen = new Set();
  for (let i = 1; i < values.length; i++) {
    const row     = values[i];
    const orderId = String(row[cOrderId] || "");
    const status  = String(row[cStatus]  || "").toLowerCase();
    if (!addonOrders.has(orderId) || status !== "paid" || seen.has(orderId)) continue;
    seen.add(orderId);
    const dt = _parseDate(row[cDate]);
    if (!dt) continue;
    const key = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
    result.set(key, (result.get(key) || 0) + 1);
  }
  return result;
}

/** Map<"yyyy-MM-dd", number> — pedidos com addon por dia da aba UpsellDaily. */
function _readUpsellDaily_(ss) {
  const result = new Map();
  const sh = ss.getSheetByName(UPSELL_SHEET);
  if (!sh) return result;

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return result;

  const header  = values[0].map(h => _normalizeHeader(h));
  const cDate   = header.findIndex(h => h === "data" || h === "dia" || h === "date");
  const cUpsell = header.findIndex(h => h === "pedidos_upsell" || h === "upsell");
  if (cDate < 0) return result;
  const uIdx = cUpsell >= 0 ? cUpsell : 1;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const dt  = row[cDate];
    if (!dt) continue;
    let key;
    if (dt instanceof Date) {
      key = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
    } else {
      const d = new Date(String(dt) + "T12:00:00");
      if (isNaN(d.getTime())) continue;
      key = Utilities.formatDate(d, TZ, "yyyy-MM-dd");
    }
    const v = Number(row[uIdx] || 0);
    if (v > 0) result.set(key, v);
  }
  return result;
}

/** Normaliza header do Google Ads (remove acentos, lowercase, underscores). */
function _normGAds_(h) {
  return String(h || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s.\-\/]+/g, "_")
    .replace(/[^\w_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Parseia número exportado pelo Google Ads (ex: "R$\u00a01.234,56" → 1234.56). */
function _parseGAdsNum_(v) {
  let s = String(v || "").trim().replace(/[^\d,.\-]/g, "");
  if (!s || s === "-" || s === "--") return 0;
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", "."); // BR: 1.234,56
    } else {
      s = s.replace(/,/g, "");                    // EN: 1,234.56
    }
  } else if (s.includes(",")) {
    const parts = s.split(",");
    if (parts[parts.length - 1].length <= 2) {
      s = s.replace(",", ".");                    // decimal: 1234,56
    } else {
      s = s.replace(/,/g, "");                    // milhar:  1,234
    }
  }
  return parseFloat(s) || 0;
}

/** Normaliza string de data do Google Ads → "yyyy-MM-dd". */
function _normalizeGAdsDate_(s) {
  s = String(s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return br[3] + "-" + br[2].padStart(2, "0") + "-" + br[1].padStart(2, "0");
  const d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, "yyyy-MM-dd");
  return "";
}
