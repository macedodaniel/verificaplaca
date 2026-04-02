/**
 * Google Ads Script — Sync intraday para Google Sheets
 * ─────────────────────────────────────────────────────
 * Grava dados de HOJE (todas as campanhas) na aba "GAds_Hoje" da planilha.
 * Agendar: a cada hora em ads.google.com → Ferramentas → Scripts → Agendamento
 *
 * COMO INSTALAR:
 *  1. Acesse ads.google.com → Ferramentas e config. → Scripts em massa → Scripts
 *  2. Clique em "+" → cole este código completo → salve como "Sync Intraday"
 *  3. Autorize o script quando solicitado
 *  4. Clique em "Agendamento" → "A cada hora"
 *  5. Rode uma vez manualmente para testar (botão ▶)
 */

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
var SHEET_ID        = "1HSIU3CNnuqlO64CIGfN_XVsPZb62aadgV20CF1JaqNE";
var SHEET_NAME      = "GAds_Hoje";
var HIST_SHEET_NAME = "GAds_Historico"; // acumula 1 linha por dia (histórico permanente)
var CAMP_SHEET_NAME = "GAds_Campanhas"; // breakdown por campanha (upsert diário)
var TIMEZONE        = "America/Sao_Paulo";

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function main() {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  // Auto-backfill: se GAds_Historico tiver menos de 7 dias, roda o backfill completo primeiro
  var hist = ss.getSheetByName(HIST_SHEET_NAME);
  var histRows = hist ? hist.getLastRow() : 0;
  if (histRows < 7) {
    Logger.log("GAds_Historico incompleto (" + histRows + " linhas). Rodando backfill automático...");
    backfillGAdsHistory();
    Logger.log("Backfill concluído. Continuando sync de hoje...");
  }

  var today = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");
  var now   = Utilities.formatDate(new Date(), TIMEZONE, "dd/MM/yyyy HH:mm");

  // ── Query 1: custo, impressões, cliques por campanha (sem segmentar por conversão) ──
  // Segmentar por conversion_action junto com cost_micros duplicaria o custo.
  var costByName   = {};  // campanha → { status, cost, impr, clicks }
  var queryCost = [
    "SELECT campaign.name, campaign.status,",
    "  metrics.cost_micros, metrics.impressions, metrics.clicks",
    "FROM campaign",
    "WHERE segments.date DURING TODAY",
    "  AND campaign.status != 'REMOVED'"
  ].join(" ");
  var rCost = AdsApp.search(queryCost);
  while (rCost.hasNext()) {
    var r = rCost.next();
    var n = r.campaign.name;
    if (!costByName[n]) costByName[n] = { status: r.campaign.status, cost:0, impr:0, clicks:0 };
    costByName[n].cost   += (r.metrics.costMicros || 0) / 1e6;
    costByName[n].impr   += parseInt(r.metrics.impressions || 0, 10);
    costByName[n].clicks += parseInt(r.metrics.clicks      || 0, 10);
  }

  // ── Query 2: somente conversões do tipo PURCHASE ──────────────────────────
  // segments.conversion_action_category = 'PURCHASE' garante apenas compras reais.
  var convByName = {};  // campanha → { conv, convVal }
  var queryConv = [
    "SELECT campaign.name, segments.conversion_action_category,",
    "  metrics.conversions, metrics.conversions_value",
    "FROM campaign",
    "WHERE segments.date DURING TODAY",
    "  AND campaign.status != 'REMOVED'",
    "  AND segments.conversion_action_category = 'PURCHASE'"
  ].join(" ");
  var rConv = AdsApp.search(queryConv);
  while (rConv.hasNext()) {
    var r = rConv.next();
    var n = r.campaign.name;
    if (!convByName[n]) convByName[n] = { conv:0, convVal:0 };
    convByName[n].conv    += parseFloat(r.metrics.conversions      || 0);
    convByName[n].convVal += parseFloat(r.metrics.conversionsValue || 0);
  }

  // ── Mescla as duas queries ────────────────────────────────────────────────
  var totalCost        = 0;
  var totalImpressions = 0;
  var totalClicks      = 0;
  var totalConv        = 0;
  var totalConvValue   = 0;
  var campRows         = [];

  Object.keys(costByName).forEach(function(name) {
    var c  = costByName[name];
    var cv = convByName[name] || { conv:0, convVal:0 };

    totalCost        += c.cost;
    totalImpressions += c.impr;
    totalClicks      += c.clicks;
    totalConv        += cv.conv;
    totalConvValue   += cv.convVal;

    campRows.push([
      today,
      name,
      c.status,
      round2(c.cost),
      c.impr,
      c.clicks,
      round2(cv.conv),
      round2(cv.convVal)
    ]);
  });

  // Ordena por custo desc (mesma ordem do Google Ads UI)
  campRows.sort(function(a, b) { return b[3] - a[3]; });

  // ── Grava na planilha ──────────────────────────────────────────────────────
  sheet.clearContents();

  // Linha de resumo (linha 1)
  var summaryHeaders = ["data","custo","impressoes","cliques","conversoes","valor_conversao","atualizado_em"];
  var summaryRow     = [today, round2(totalCost), totalImpressions, totalClicks,
                        round2(totalConv), round2(totalConvValue), now];
  sheet.getRange(1, 1, 1, summaryHeaders.length).setValues([summaryHeaders]);
  sheet.getRange(2, 1, 1, summaryHeaders.length).setValues([summaryRow]);

  // Separador + breakdown por campanha (linhas 4 em diante)
  if (campRows.length) {
    var campHeaders = ["data","campanha","status","custo","impressoes","cliques","conversoes","valor_conversao"];
    sheet.getRange(4, 1, 1, campHeaders.length).setValues([campHeaders]);
    sheet.getRange(5, 1, campRows.length, campHeaders.length).setValues(campRows);
  }

  sheet.autoResizeColumns(1, 8);

  // ── Acumula histórico diário em GAds_Historico (upsert por data) ──────────
  // Garante que cada dia tenha exatamente 1 linha com os dados mais recentes.
  // O Apps Script da planilha lê essa aba para montar o custo histórico.
  updateHistory_(ss, today, round2(totalCost), totalImpressions,
                 totalClicks, round2(totalConv), round2(totalConvValue), now);

  // ── Acumula breakdown por campanha em GAds_Campanhas (upsert por data+campanha) ──
  updateCampaignHistory_(ss, today, campRows, now);

  // ── Grava purchases em GAds_Conversoes (checkouts vêm do Pagar.me via pagarme-unified.js) ──
  // Auto-backfill: se a aba tiver menos de 7 dias, popula o histórico completo.
  var convSh = ss.getSheetByName(CONV_SHEET_NAME);
  var convRows = convSh ? convSh.getLastRow() - 1 : 0;
  if (convRows < 7) {
    Logger.log("GAds_Conversoes incompleto (" + convRows + " linhas). Rodando backfill automático...");
    backfillConversoes();
    Logger.log("Backfill de conversões concluído.");
  } else {
    updateConversoesDiarias_(ss, today, now);
  }

  Logger.log(
    "GAds_Hoje: " + campRows.length + " campanhas · " +
    "custo=R$" + round2(totalCost) + " · " +
    "cliques=" + totalClicks + " · " +
    "conv=" + round2(totalConv) + " · " +
    "atualizado=" + now
  );
}

// ─── HISTÓRICO DIÁRIO ─────────────────────────────────────────────────────────
var HIST_HEADERS = ["data","custo","impressoes","cliques","conversoes","valor_conversao","atualizado_em"];

function updateHistory_(ss, today, cost, impr, clicks, conv, convVal, now) {
  var hist = ss.getSheetByName(HIST_SHEET_NAME);
  if (!hist) hist = ss.insertSheet(HIST_SHEET_NAME);

  var newRow = [today, cost, impr, clicks, conv, convVal, now];
  var data   = hist.getDataRange().getValues();

  // Verifica se a primeira linha é realmente o cabeçalho esperado
  var hasHeader = data.length > 0 && String(data[0][0]).trim().toLowerCase() === "data";

  if (!hasHeader) {
    // Recria aba do zero (estava vazia ou com lixo)
    hist.clearContents();
    hist.getRange(1, 1, 1, HIST_HEADERS.length).setValues([HIST_HEADERS]);
    hist.getRange(2, 1, 1, HIST_HEADERS.length).setValues([newRow]);
    hist.autoResizeColumns(1, HIST_HEADERS.length);
    return;
  }

  // Procura linha com a data para fazer upsert.
  // Sheets armazena strings "yyyy-MM-dd" como meia-noite UTC (T00:00:00.000Z).
  // Formatar com TIMEZONE (São Paulo, UTC-3) daria "dia anterior" → usar "UTC".
  for (var i = 1; i < data.length; i++) {
    var rowDate    = data[i][0];
    var rowDateStr = (rowDate instanceof Date)
      ? Utilities.formatDate(rowDate, "UTC", "yyyy-MM-dd")
      : String(rowDate || "").trim().substring(0, 10);
    if (rowDateStr === today) {
      hist.getRange(i + 1, 1, 1, HIST_HEADERS.length).setValues([newRow]);
      hist.autoResizeColumns(1, HIST_HEADERS.length);
      return;
    }
  }

  // Data nova → append
  hist.getRange(data.length + 1, 1, 1, HIST_HEADERS.length).setValues([newRow]);
  hist.autoResizeColumns(1, HIST_HEADERS.length);
}

// ─── BACKFILL: últimos N dias ─────────────────────────────────────────────────
// Rode UMA VEZ manualmente para popular o histórico completo.
// Em ads.google.com → Scripts → selecione "backfillGAdsHistory" no dropdown → ▶
function backfillGAdsHistory() {
  var DAYS_BACK = 60; // quantos dias buscar
  var ss   = SpreadsheetApp.openById(SHEET_ID);
  var hist = ss.getSheetByName(HIST_SHEET_NAME);
  if (!hist) hist = ss.insertSheet(HIST_SHEET_NAME);

  // Calcula intervalo de datas (GAQL não aceita LAST_60_DAYS — usa BETWEEN)
  var endDate   = new Date();
  var startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS_BACK);
  var fmt = function(d) { return Utilities.formatDate(d, TIMEZONE, "yyyy-MM-dd"); };

  // Query 1: custo por data (sem segmentar por conversão)
  var queryCostHist = [
    "SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks",
    "FROM campaign",
    "WHERE segments.date BETWEEN '" + fmt(startDate) + "' AND '" + fmt(endDate) + "'",
    "  AND campaign.status != 'REMOVED'"
  ].join(" ");
  var byDate = {};
  var rCostH = AdsApp.search(queryCostHist);
  while (rCostH.hasNext()) {
    var row = rCostH.next();
    var date = row.segments.date;
    if (!byDate[date]) byDate[date] = { cost:0, impr:0, clicks:0, conv:0, convVal:0 };
    byDate[date].cost  += (row.metrics.costMicros || 0) / 1e6;
    byDate[date].impr  += parseInt(row.metrics.impressions || 0, 10);
    byDate[date].clicks+= parseInt(row.metrics.clicks      || 0, 10);
  }

  // Query 2: somente conversões PURCHASE por data
  var queryConvHist = [
    "SELECT segments.date, segments.conversion_action_category,",
    "  metrics.conversions, metrics.conversions_value",
    "FROM campaign",
    "WHERE segments.date BETWEEN '" + fmt(startDate) + "' AND '" + fmt(endDate) + "'",
    "  AND campaign.status != 'REMOVED'",
    "  AND segments.conversion_action_category = 'PURCHASE'"
  ].join(" ");
  var rConvH = AdsApp.search(queryConvHist);
  while (rConvH.hasNext()) {
    var row = rConvH.next();
    var date = row.segments.date;
    if (!byDate[date]) byDate[date] = { cost:0, impr:0, clicks:0, conv:0, convVal:0 };
    byDate[date].conv    += parseFloat(row.metrics.conversions      || 0);
    byDate[date].convVal += parseFloat(row.metrics.conversionsValue || 0);
  }

  var dates   = Object.keys(byDate).sort();
  var now     = Utilities.formatDate(new Date(), TIMEZONE, "dd/MM/yyyy HH:mm");

  // Recria aba com cabeçalho + todos os dias ordenados
  hist.clearContents();
  hist.getRange(1, 1, 1, HIST_HEADERS.length).setValues([HIST_HEADERS]);

  var rows = dates.map(function(d) {
    var v = byDate[d];
    return [d, round2(v.cost), v.impr, v.clicks, round2(v.conv), round2(v.convVal), now];
  });

  if (rows.length) {
    hist.getRange(2, 1, rows.length, HIST_HEADERS.length).setValues(rows);
  }
  hist.autoResizeColumns(1, HIST_HEADERS.length);

  Logger.log("backfillGAdsHistory: " + rows.length + " dias gravados em " + HIST_SHEET_NAME);
  Logger.log("Custo total: R$" + rows.reduce(function(s,r){ return s + r[1]; }, 0).toFixed(2));
}

// ─── BREAKDOWN POR CAMPANHA ───────────────────────────────────────────────────
var CAMP_HEADERS = ["data","campanha","custo","conversoes","valor_conversao","atualizado_em"];

/**
 * Upsert de today's per-campaign rows em GAds_Campanhas.
 * campRows vem do main(): [date, name, status, cost, impr, clicks, conv, convVal]
 */
function updateCampaignHistory_(ss, today, campRows, now) {
  var sh = ss.getSheetByName(CAMP_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CAMP_SHEET_NAME);

  var existing = sh.getDataRange().getValues();
  var hasHeader = existing.length > 0 &&
                  String(existing[0][0]).trim().toLowerCase() === "data";
  if (!hasHeader) {
    sh.clearContents();
    sh.getRange(1, 1, 1, CAMP_HEADERS.length).setValues([CAMP_HEADERS]);
    existing = [CAMP_HEADERS.slice()];
  }

  // Mapa de linhas existentes por "data|campanha"
  var keyToIdx = {};
  for (var i = 1; i < existing.length; i++) {
    var rawDate = existing[i][0];
    var ds = (rawDate instanceof Date)
      ? Utilities.formatDate(rawDate, "UTC", "yyyy-MM-dd")
      : String(rawDate || "").trim().substring(0, 10);
    keyToIdx[ds + "|" + String(existing[i][1] || "")] = i;
  }

  // Novas linhas de hoje: [date, campaign, cost, conversions, convValue, updated]
  var newRows = campRows.map(function(r) {
    return [r[0], r[1], r[3], r[6], r[7], now];
  });

  // Copia linhas existentes (sem header) para edição
  var data = existing.slice(1);
  newRows.forEach(function(nr) {
    var key = nr[0] + "|" + nr[1];
    if (keyToIdx.hasOwnProperty(key)) {
      data[keyToIdx[key] - 1] = nr; // atualiza linha existente
    } else {
      data.push(nr);               // nova linha
    }
  });

  // Ordena: data desc, campanha asc
  data.sort(function(a, b) {
    var d = String(b[0]).localeCompare(String(a[0]));
    return d !== 0 ? d : String(a[1]).localeCompare(String(b[1]));
  });

  sh.clearContents();
  sh.getRange(1, 1, 1, CAMP_HEADERS.length).setValues([CAMP_HEADERS]);
  if (data.length > 0) {
    sh.getRange(2, 1, data.length, CAMP_HEADERS.length).setValues(data);
  }
  sh.autoResizeColumns(1, CAMP_HEADERS.length);
  Logger.log("GAds_Campanhas: " + data.length + " linhas totais após upsert de " + today);
}

/**
 * Rode UMA VEZ manualmente para popular o histórico completo de campanhas.
 * Em ads.google.com → Scripts → dropdown → "backfillCampaignHistory" → ▶
 */
function backfillCampaignHistory() {
  var DAYS_BACK = 90;
  var ss  = SpreadsheetApp.openById(SHEET_ID);
  var sh  = ss.getSheetByName(CAMP_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CAMP_SHEET_NAME);

  var endDate   = new Date();
  var startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS_BACK);
  var fmt = function(d) { return Utilities.formatDate(d, TIMEZONE, "yyyy-MM-dd"); };

  var now = Utilities.formatDate(new Date(), TIMEZONE, "dd/MM/yyyy HH:mm");

  // Query 1: custo por data+campanha
  var byCamp = {};
  var qCostC = [
    "SELECT segments.date, campaign.name, metrics.cost_micros",
    "FROM campaign",
    "WHERE segments.date BETWEEN '" + fmt(startDate) + "' AND '" + fmt(endDate) + "'",
    "  AND campaign.status != 'REMOVED'",
    "  AND metrics.cost_micros > 0"
  ].join(" ");
  var rCC = AdsApp.search(qCostC);
  while (rCC.hasNext()) {
    var r = rCC.next();
    var k = r.segments.date + "|" + r.campaign.name;
    if (!byCamp[k]) byCamp[k] = { date: r.segments.date, name: r.campaign.name, cost:0, conv:0, convVal:0 };
    byCamp[k].cost += (r.metrics.costMicros || 0) / 1e6;
  }

  // Query 2: somente PURCHASE por data+campanha
  var qConvC = [
    "SELECT segments.date, campaign.name, segments.conversion_action_category,",
    "  metrics.conversions, metrics.conversions_value",
    "FROM campaign",
    "WHERE segments.date BETWEEN '" + fmt(startDate) + "' AND '" + fmt(endDate) + "'",
    "  AND campaign.status != 'REMOVED'",
    "  AND segments.conversion_action_category = 'PURCHASE'"
  ].join(" ");
  var rConvC = AdsApp.search(qConvC);
  while (rConvC.hasNext()) {
    var r = rConvC.next();
    var k = r.segments.date + "|" + r.campaign.name;
    if (!byCamp[k]) byCamp[k] = { date: r.segments.date, name: r.campaign.name, cost:0, conv:0, convVal:0 };
    byCamp[k].conv    += parseFloat(r.metrics.conversions      || 0);
    byCamp[k].convVal += parseFloat(r.metrics.conversionsValue || 0);
  }

  var rows = Object.values(byCamp).map(function(v) {
    return [v.date, v.name, round2(v.cost), round2(v.conv), round2(v.convVal), now];
  });

  rows.sort(function(a, b) {
    var d = String(b[0]).localeCompare(String(a[0]));
    return d !== 0 ? d : String(a[1]).localeCompare(String(b[1]));
  });

  sh.clearContents();
  sh.getRange(1, 1, 1, CAMP_HEADERS.length).setValues([CAMP_HEADERS]);
  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, CAMP_HEADERS.length).setValues(rows);
  }
  sh.autoResizeColumns(1, CAMP_HEADERS.length);
  Logger.log("backfillCampaignHistory: " + rows.length + " linhas gravadas em " + CAMP_SHEET_NAME);
}

// ─── CONVERSÕES DIÁRIAS (checkouts + purchases) ───────────────────────────────
var CONV_SHEET_NAME    = "GAds_Conversoes";
var CONV_HEADERS       = ["dia", "acao", "conversoes", "valor_conv", "atualizado_em"];

/**
 * Grava as conversões de HOJE em GAds_Conversoes:
 *   - begin_checkout → metrics.all_conversions (é conversão secundária)
 *   - purchase       → metrics.conversions      (é conversão primária)
 *
 * Formato de saída:
 *   dia | acao | conversoes | valor_conv | atualizado_em
 */
function updateConversoesDiarias_(ss, today, now) {
  var sh = ss.getSheetByName(CONV_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONV_SHEET_NAME);

  // ── Query: BEGIN_CHECKOUT (secundária → all_conversions) ─────────────────
  var checkouts = 0;
  var qCheckout = [
    "SELECT segments.conversion_action_category,",
    "  metrics.all_conversions, metrics.all_conversions_value",
    "FROM campaign",
    "WHERE segments.date DURING TODAY",
    "  AND campaign.status != 'REMOVED'",
    "  AND segments.conversion_action_category = 'BEGIN_CHECKOUT'"
  ].join(" ");
  var rCk = AdsApp.search(qCheckout);
  while (rCk.hasNext()) {
    var r = rCk.next();
    checkouts += parseFloat(r.metrics.allConversions || 0);
  }

  // ── Query: PURCHASE (primária → conversions) ──────────────────────────────
  var purchases = 0;
  var purchaseVal = 0;
  var qPurchase = [
    "SELECT segments.conversion_action_category,",
    "  metrics.conversions, metrics.conversions_value",
    "FROM campaign",
    "WHERE segments.date DURING TODAY",
    "  AND campaign.status != 'REMOVED'",
    "  AND segments.conversion_action_category = 'PURCHASE'"
  ].join(" ");
  var rPu = AdsApp.search(qPurchase);
  while (rPu.hasNext()) {
    var r = rPu.next();
    purchases   += parseFloat(r.metrics.conversions      || 0);
    purchaseVal += parseFloat(r.metrics.conversionsValue || 0);
  }

  // ── Monta as linhas de hoje ───────────────────────────────────────────────
  var newRows = [
    [today, "begin_checkout", round2(checkouts),  0,                   now],
    [today, "purchase",       round2(purchases),  round2(purchaseVal), now]
  ];

  // ── Lê dados existentes, remove linhas de hoje e reescreve ─────────────────
  var existing = sh.getDataRange().getValues();
  var hasHeader = existing.length > 0 &&
                  String(existing[0][0]).trim().toLowerCase() === "dia";

  if (!hasHeader) {
    sh.clearContents();
    sh.getRange(1, 1, 1, CONV_HEADERS.length).setValues([CONV_HEADERS]);
    existing = [CONV_HEADERS.slice()];
  }

  // Mantém apenas linhas que NÃO sejam de hoje
  var kept = existing.slice(1).filter(function(row) {
    var rawDate = row[0];
    var ds = (rawDate instanceof Date)
      ? Utilities.formatDate(rawDate, "UTC", "yyyy-MM-dd")
      : String(rawDate || "").trim().substring(0, 10);
    return ds !== today;
  });

  // Acrescenta as linhas de hoje
  var allData = kept.concat(newRows);

  // Ordena: data desc, acao asc
  allData.sort(function(a, b) {
    var d = String(b[0]).localeCompare(String(a[0]));
    return d !== 0 ? d : String(a[1]).localeCompare(String(b[1]));
  });

  sh.clearContents();
  sh.getRange(1, 1, 1, CONV_HEADERS.length).setValues([CONV_HEADERS]);
  if (allData.length > 0) {
    sh.getRange(2, 1, allData.length, CONV_HEADERS.length).setValues(allData);
  }
  sh.autoResizeColumns(1, CONV_HEADERS.length);

  Logger.log("GAds_Conversoes: " + today + " | purchases=" + round2(purchases));
}

// ─── BACKFILL: últimos N dias de purchases ────────────────────────────────────
/**
 * Popula histórico de PURCHASE em GAds_Conversoes (60 dias).
 * Chamado automaticamente pelo main() quando a aba tem menos de 7 linhas.
 * Checkouts são derivados do Pagar.me em pagarme-unified.js.
 */
function backfillConversoes() {
  var DAYS_BACK = 60;
  var ss  = SpreadsheetApp.openById(SHEET_ID);
  var sh  = ss.getSheetByName(CONV_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONV_SHEET_NAME);

  var endDate   = new Date();
  var startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS_BACK);
  var fmt = function(d) { return Utilities.formatDate(d, TIMEZONE, "yyyy-MM-dd"); };
  var now = Utilities.formatDate(new Date(), TIMEZONE, "dd/MM/yyyy HH:mm");
  var range = "'" + fmt(startDate) + "' AND '" + fmt(endDate) + "'";

  // BEGIN_CHECKOUT (secundária → all_conversions)
  var byDate = {};
  var qCk = [
    "SELECT segments.date, segments.conversion_action_category,",
    "  metrics.all_conversions",
    "FROM campaign",
    "WHERE segments.date BETWEEN " + range,
    "  AND campaign.status != 'REMOVED'",
    "  AND segments.conversion_action_category = 'BEGIN_CHECKOUT'"
  ].join(" ");
  var rCk = AdsApp.search(qCk);
  while (rCk.hasNext()) {
    var r = rCk.next();
    var dt = r.segments.date;
    if (!byDate[dt]) byDate[dt] = { ck:0, pu:0, puVal:0 };
    byDate[dt].ck += parseFloat(r.metrics.allConversions || 0);
  }

  // PURCHASE (primária → conversions)
  var qPu = [
    "SELECT segments.date, segments.conversion_action_category,",
    "  metrics.conversions, metrics.conversions_value",
    "FROM campaign",
    "WHERE segments.date BETWEEN " + range,
    "  AND campaign.status != 'REMOVED'",
    "  AND segments.conversion_action_category = 'PURCHASE'"
  ].join(" ");
  var rPu = AdsApp.search(qPu);
  while (rPu.hasNext()) {
    var r = rPu.next();
    var dt = r.segments.date;
    if (!byDate[dt]) byDate[dt] = { ck:0, pu:0, puVal:0 };
    byDate[dt].pu    += parseFloat(r.metrics.conversions      || 0);
    byDate[dt].puVal += parseFloat(r.metrics.conversionsValue || 0);
  }

  var rows = [];
  Object.keys(byDate).sort().reverse().forEach(function(dt) {
    var v = byDate[dt];
    rows.push([dt, "begin_checkout", round2(v.ck), 0,             now]);
    rows.push([dt, "purchase",       round2(v.pu), round2(v.puVal), now]);
  });

  sh.clearContents();
  sh.getRange(1, 1, 1, CONV_HEADERS.length).setValues([CONV_HEADERS]);
  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, CONV_HEADERS.length).setValues(rows);
  }
  sh.autoResizeColumns(1, CONV_HEADERS.length);
  Logger.log("backfillConversoes: " + Object.keys(byDate).length + " dias gravados.");
}

function round2(n) { return Math.round(n * 100) / 100; }
