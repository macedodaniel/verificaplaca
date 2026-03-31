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

  // ── Consulta GAQL — todas campanhas ativas HOJE ──
  var query = [
    "SELECT",
    "  campaign.name,",
    "  campaign.status,",
    "  metrics.cost_micros,",
    "  metrics.impressions,",
    "  metrics.clicks,",
    "  metrics.conversions,",
    "  metrics.conversions_value",
    "FROM campaign",
    "WHERE segments.date DURING TODAY",
    "  AND campaign.status != 'REMOVED'",
    "ORDER BY metrics.cost_micros DESC"
  ].join(" ");

  var report = AdsApp.search(query);

  // Totais agregados
  var totalCost       = 0;
  var totalImpressions = 0;
  var totalClicks     = 0;
  var totalConv       = 0;
  var totalConvValue  = 0;

  // Linhas por campanha
  var campRows = [];

  while (report.hasNext()) {
    var row     = report.next();
    var camp    = row.campaign;
    var metrics = row.metrics;

    var cost      = (metrics.costMicros      || 0) / 1e6;
    var impr      = metrics.impressions      || 0;
    var clicks    = metrics.clicks           || 0;
    var conv      = metrics.conversions      || 0;
    var convVal   = metrics.conversionsValue || 0;

    totalCost        += cost;
    totalImpressions += parseInt(impr,  10);
    totalClicks      += parseInt(clicks, 10);
    totalConv        += parseFloat(conv);
    totalConvValue   += parseFloat(convVal);

    campRows.push([
      today,
      camp.name,
      camp.status,
      round2(cost),
      parseInt(impr,  10),
      parseInt(clicks, 10),
      round2(parseFloat(conv)),
      round2(parseFloat(convVal))
    ]);
  }

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

  // Procura linha com a data para fazer upsert
  for (var i = 1; i < data.length; i++) {
    var rowDate    = data[i][0];
    var rowDateStr = (rowDate instanceof Date)
      ? Utilities.formatDate(rowDate, TIMEZONE, "yyyy-MM-dd")
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

  var query = [
    "SELECT",
    "  segments.date,",
    "  metrics.cost_micros,",
    "  metrics.impressions,",
    "  metrics.clicks,",
    "  metrics.conversions,",
    "  metrics.conversions_value",
    "FROM campaign",
    "WHERE segments.date BETWEEN '" + fmt(startDate) + "' AND '" + fmt(endDate) + "'",
    "  AND campaign.status != 'REMOVED'"
  ].join(" ");

  var report = AdsApp.search(query);

  // Agrega por data
  var byDate = {};
  while (report.hasNext()) {
    var row     = report.next();
    var date    = row.segments.date;          // "yyyy-MM-dd"
    var metrics = row.metrics;
    if (!byDate[date]) byDate[date] = { cost:0, impr:0, clicks:0, conv:0, convVal:0 };
    byDate[date].cost    += (metrics.costMicros      || 0) / 1e6;
    byDate[date].impr    += parseInt(metrics.impressions      || 0, 10);
    byDate[date].clicks  += parseInt(metrics.clicks           || 0, 10);
    byDate[date].conv    += parseFloat(metrics.conversions    || 0);
    byDate[date].convVal += parseFloat(metrics.conversionsValue || 0);
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

function round2(n) { return Math.round(n * 100) / 100; }
