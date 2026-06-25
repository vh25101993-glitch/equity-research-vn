#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  drawdownEpisodeProfile,
  finiteNumber,
  normalizedStockHistoryRows,
  percentileOfValue,
  quantile,
  rollingReturnSeries,
} from "./stock_history_calculations.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(repoRoot, "market_stats", "web");
const dataPath = path.join(webRoot, "market_stats_data.json");
const seriesDir = path.join(webRoot, "series");
const outDir = path.join(webRoot, "stock_profiles");
const reportDir = path.join(repoRoot, "market_stats", "reports");
const factorConfidencePath = path.join(reportDir, "price_factor_confidence_latest.json");
const factorQueuePath = path.join(reportDir, "factor_unresolved_queue_latest.json");
const requestedSymbols = process.argv.slice(2).map(safeSymbol).filter(Boolean);
const mandatoryBenchmarks = ["VNINDEX", "VN30", "VNDIAMOND"];
const preferredMembershipBenchmarks = ["VN30", "VN100", "VNMIDCAP", "VNSML", "VNALL", "VNXALL", "VN50", "VNDIAMOND", "VNFINSELECT", "VNDIVIDEND", "VNCOND", "VNCONS", "VNENE", "VNFIN", "VNHEAL", "VNIND", "VNIT", "VNMAT", "VNREAL", "VNUTI"];
const sectorIndexProxies = ["VNCOND", "VNCONS", "VNENE", "VNFIN", "VNHEAL", "VNIND", "VNIT", "VNMAT", "VNREAL", "VNUTI"];

function safeSymbol(symbol) {
  return String(symbol || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function round(value, digits = 2) {
  return finiteNumber(value) ? Number(value.toFixed(digits)) : null;
}

function mean(values = []) {
  const nums = values.filter(finiteNumber);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function stdDev(values = []) {
  const nums = values.filter(finiteNumber);
  if (nums.length < 2) return null;
  const avg = mean(nums);
  return Math.sqrt(nums.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (nums.length - 1));
}

function skewness(values = []) {
  const nums = values.filter(finiteNumber);
  if (nums.length < 3) return null;
  const avg = mean(nums);
  const sd = stdDev(nums);
  if (!sd) return null;
  const n = nums.length;
  return (n / ((n - 1) * (n - 2))) * nums.reduce((sum, value) => sum + ((value - avg) / sd) ** 3, 0);
}

function excessKurtosis(values = []) {
  const nums = values.filter(finiteNumber);
  if (nums.length < 4) return null;
  const avg = mean(nums);
  const sd = stdDev(nums);
  if (!sd) return null;
  const n = nums.length;
  const z4 = nums.reduce((sum, value) => sum + ((value - avg) / sd) ** 4, 0);
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * z4
    - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}

function median(values = []) {
  return quantile(values, 0.5);
}

function logReturns(rows = []) {
  const out = [];
  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1]?.close;
    const cur = rows[index]?.close;
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

function dailyReturns(rows = []) {
  const out = [];
  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1]?.close;
    const cur = rows[index]?.close;
    if (prev > 0 && cur > 0) out.push((cur / prev - 1) * 100);
  }
  return out;
}

function dailyObservationRows(rows = []) {
  const out = [];
  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1];
    const cur = rows[index];
    if (!(prev.close > 0) || !(cur.close > 0)) continue;
    const ret = (cur.close / prev.close - 1) * 100;
    const gap = cur.open && prev.close ? (cur.open / prev.close - 1) * 100 : null;
    const range = cur.high && cur.low && prev.close ? (cur.high - cur.low) / prev.close * 100 : cur.range_pct ?? null;
    out.push({
      date: cur.date,
      ret_pct: round(ret),
      abs_ret_pct: round(Math.abs(ret)),
      gap_pct: round(gap),
      abs_gap_pct: finiteNumber(gap) ? round(Math.abs(gap)) : null,
      range_pct: round(range),
      volume: cur.volume ?? null,
      value: cur.value ?? null,
      volume_spike_20d: finiteNumber(cur.volume_spike_20d) ? round(cur.volume_spike_20d) : null,
    });
  }
  return out;
}

function drawdownSeriesFromRows(rows = []) {
  let peak = null;
  return rows.map(row => {
    const close = row?.close;
    if (!finiteNumber(close)) return null;
    peak = peak === null ? close : Math.max(peak, close);
    return peak ? close / peak - 1 : null;
  });
}

function realizedVol(rows = [], window) {
  const values = logReturns(rows).slice(-1 * window);
  if (values.length < Math.max(5, Math.floor(window / 3))) return null;
  return round(stdDev(values) * Math.sqrt(252) * 100);
}

function realizedVolHistory(rows = [], window) {
  const values = [];
  const returns = logReturns(rows);
  const minCount = Math.max(5, Math.floor(window / 3));
  for (let index = minCount; index <= returns.length; index += 1) {
    const sample = returns.slice(Math.max(0, index - window), index);
    const value = sample.length >= minCount ? round(stdDev(sample) * Math.sqrt(252) * 100) : null;
    if (finiteNumber(value)) values.push(value);
  }
  return values;
}

function pctChange(rows = [], window) {
  if (rows.length <= window) return null;
  const start = rows[rows.length - 1 - window]?.close;
  const end = rows[rows.length - 1]?.close;
  if (!(start > 0) || !(end > 0)) return null;
  return round((end / start - 1) * 100);
}

function rollingReturnProfile(rows = [], window) {
  const series = rollingReturnSeries(rows, window);
  const values = series.map(row => row.value).filter(finiteNumber);
  const current = values.length ? values[values.length - 1] : null;
  return {
    window,
    current_return_pct: current,
    percentile: percentileOfValue(values, current),
    median_return_pct: round(median(values)),
    p10_return_pct: round(quantile(values, 0.1)),
    p90_return_pct: round(quantile(values, 0.9)),
    observations: values.length,
  };
}

function maxRunupProfile(rows = []) {
  if (!rows.length) return null;
  let lowIndex = 0;
  let best = { value_pct: null, low_date: rows[0].date, high_date: rows[0].date };
  rows.forEach((row, index) => {
    if (row.close < rows[lowIndex].close) lowIndex = index;
    const low = rows[lowIndex].close;
    if (low > 0) {
      const value = (row.close / low - 1) * 100;
      if (!finiteNumber(best.value_pct) || value > best.value_pct) {
        best = { value_pct: round(value), low_date: rows[lowIndex].date, high_date: row.date };
      }
    }
  });
  return best;
}

function thresholdCounts(values = []) {
  const nums = values.filter(finiteNumber);
  return {
    observations: nums.length,
    up_5_pct: nums.filter(value => value >= 5).length,
    down_5_pct: nums.filter(value => value <= -5).length,
    up_10_pct: nums.filter(value => value >= 10).length,
    down_10_pct: nums.filter(value => value <= -10).length,
  };
}

function averageValue(rows = [], window) {
  return round(mean(rows.slice(-1 * window).map(row => row.value).filter(finiteNumber)), 0);
}

function averageVolume(rows = [], window) {
  return round(mean(rows.slice(-1 * window).map(row => row.volume).filter(finiteNumber)), 0);
}

function sum(values = []) {
  const nums = values.filter(finiteNumber);
  if (!nums.length) return null;
  return nums.reduce((total, value) => total + value, 0);
}

function smaAt(rows = [], index, key = "close", window = 20) {
  const sample = rows.slice(index - window + 1, index + 1).map(row => row[key]).filter(finiteNumber);
  if (sample.length < window) return null;
  return mean(sample);
}

function vwmaAt(rows = [], index, key = "close", window = 20) {
  const sample = rows.slice(index - window + 1, index + 1)
    .filter(row => finiteNumber(row[key]) && finiteNumber(row.volume) && row.volume > 0);
  if (sample.length < window) return null;
  const volumeSum = sum(sample.map(row => row.volume));
  if (!volumeSum) return null;
  return sample.reduce((total, row) => total + row[key] * row.volume, 0) / volumeSum;
}

function weightedMean(items = [], valueKey = "value", weightKey = "weight") {
  const sample = items.filter(item => finiteNumber(item[valueKey]) && finiteNumber(item[weightKey]) && item[weightKey] > 0);
  if (!sample.length) return null;
  const weightSum = sum(sample.map(item => item[weightKey]));
  if (!weightSum) return null;
  return sample.reduce((total, item) => total + item[valueKey] * item[weightKey], 0) / weightSum;
}

function lineChangePct(series = [], window = 20) {
  const values = series.filter(row => finiteNumber(row.value));
  if (values.length <= window) return null;
  const latest = values.at(-1).value;
  const start = values[values.length - 1 - window].value;
  if (!finiteNumber(latest) || !finiteNumber(start)) return null;
  const denominator = Math.max(Math.abs(start), 1);
  return (latest - start) / denominator * 100;
}

function movingAverageBefore(rows = [], index, key, window) {
  const sample = rows
    .slice(Math.max(0, index - window), index)
    .map(row => row[key])
    .filter(finiteNumber);
  if (!sample.length) return null;
  return mean(sample);
}

function liquidityStability(rows = [], window = 63) {
  const values = rows.slice(-1 * window).map(row => row.value).filter(value => finiteNumber(value) && value > 0);
  if (values.length < Math.max(10, Math.floor(window / 3))) return null;
  const avg = mean(values);
  const sd = stdDev(values);
  return avg ? round(sd / avg) : null;
}

function spikeDays(rows = [], window = 252) {
  const tail = rows.slice(-1 * window);
  return tail
    .filter(row => finiteNumber(row.volume_spike_20d) && row.volume_spike_20d >= 3)
    .map(row => ({ date: row.date, volume_spike_20d: round(row.volume_spike_20d), value: row.value ?? null }))
    .slice(-20);
}

function topByAbs(rows = [], key, limit = 10) {
  return [...rows]
    .filter(row => finiteNumber(row[key]))
    .sort((a, b) => Math.abs(b[key]) - Math.abs(a[key]))
    .slice(0, limit);
}

function shockGapProfile(rows = []) {
  const daily = dailyObservationRows(rows);
  const tail = daily.slice(-252);
  return {
    observations: daily.length,
    shock_5pct_count_1y: tail.filter(row => row.abs_ret_pct >= 5).length,
    shock_10pct_count_1y: tail.filter(row => row.abs_ret_pct >= 10).length,
    gap_3pct_count_1y: tail.filter(row => row.abs_gap_pct >= 3).length,
    range_p90_1y_pct: round(quantile(tail.map(row => row.range_pct).filter(finiteNumber), 0.9)),
    largest_up_days: [...daily].filter(row => finiteNumber(row.ret_pct)).sort((a, b) => b.ret_pct - a.ret_pct).slice(0, 5),
    largest_down_days: [...daily].filter(row => finiteNumber(row.ret_pct)).sort((a, b) => a.ret_pct - b.ret_pct).slice(0, 5),
    largest_gap_days: topByAbs(daily, "gap_pct", 5),
    volume_shock_days_1y: tail.filter(row => finiteNumber(row.volume_spike_20d) && row.volume_spike_20d >= 3).slice(-10),
    interpretation_guardrail: "Shock/gap chỉ ghi nhận các phiên đã xảy ra; không phải mô hình dự báo phiên tiếp theo.",
  };
}

function volumePriceProfile(rows = []) {
  const daily = dailyObservationRows(rows);
  const tail = daily.slice(-252);
  const up = tail.filter(row => row.ret_pct > 0);
  const down = tail.filter(row => row.ret_pct < 0);
  const avgUpValue = mean(up.map(row => row.value).filter(finiteNumber));
  const avgDownValue = mean(down.map(row => row.value).filter(finiteNumber));
  const retValuePairs = tail.filter(row => finiteNumber(row.ret_pct) && finiteNumber(row.value)).map(row => ({ ret: row.ret_pct, value: row.value }));
  const absRetValuePairs = tail.filter(row => finiteNumber(row.abs_ret_pct) && finiteNumber(row.value)).map(row => ({ abs_ret: row.abs_ret_pct, value: row.value }));
  const volumeSpikeRows = tail.filter(row => finiteNumber(row.volume_spike_20d) && row.volume_spike_20d >= 2);
  let descriptor = "trung tính";
  if (avgUpValue && avgDownValue && avgUpValue / avgDownValue >= 1.2) descriptor = "khối lượng nghiêng về phiên tăng";
  if (avgUpValue && avgDownValue && avgDownValue / avgUpValue >= 1.2) descriptor = "khối lượng nghiêng về phiên giảm";
  return {
    observations_1y: tail.length,
    avg_value_up_days_1y: round(avgUpValue, 0),
    avg_value_down_days_1y: round(avgDownValue, 0),
    up_down_value_ratio_1y: avgUpValue && avgDownValue ? round(avgUpValue / avgDownValue, 4) : null,
    ret_value_correlation_1y: round(corrFromPairs(retValuePairs, "ret", "value"), 4),
    abs_ret_value_correlation_1y: round(corrFromPairs(absRetValuePairs, "abs_ret", "value"), 4),
    volume_spike_2x_count_1y: volumeSpikeRows.length,
    up_volume_spike_2x_count_1y: volumeSpikeRows.filter(row => row.ret_pct > 0).length,
    down_volume_spike_2x_count_1y: volumeSpikeRows.filter(row => row.ret_pct < 0).length,
    descriptor,
    interpretation_guardrail: "Volume-price là mô tả đồng biến giá-khối lượng, không phải accumulation/distribution theo nghĩa tín hiệu giao dịch.",
  };
}

function participationLabel({ latestVolumePercentile, normalizedVolume20d, normalizedValue20d }) {
  if (!finiteNumber(latestVolumePercentile) && !finiteNumber(normalizedVolume20d) && !finiteNumber(normalizedValue20d)) return "chưa đủ dữ liệu";
  const strongest = Math.max(
    finiteNumber(normalizedVolume20d) ? normalizedVolume20d : 0,
    finiteNumber(normalizedValue20d) ? normalizedValue20d : 0,
  );
  if ((latestVolumePercentile ?? 0) >= 95 || strongest >= 3) return "extreme";
  if ((latestVolumePercentile ?? 0) >= 80 || strongest >= 2) return "active";
  if ((latestVolumePercentile ?? 100) <= 20 || strongest <= 0.5) return "thin";
  return "normal";
}

function volumeParticipationProfile(rows = []) {
  const latest = rows.at(-1) || {};
  const tail = rows.slice(-252);
  const volumes1y = tail.map(row => row.volume).filter(value => finiteNumber(value) && value >= 0);
  const values1y = tail.map(row => row.value).filter(value => finiteNumber(value) && value >= 0);
  const avgVolume20 = averageVolume(rows, 20);
  const avgValue20 = averageValue(rows, 20);
  const latestVolume = finiteNumber(latest.volume) ? latest.volume : null;
  const latestValue = finiteNumber(latest.value) ? latest.value : null;
  const highVolumeDays = [];
  const extremeVolumeDays = [];
  const lowVolumeDays = [];
  rows.forEach((row, index) => {
    if (!tail.includes(row)) return;
    const avg20 = movingAverageBefore(rows, index, "volume", 20);
    if (!finiteNumber(row.volume) || !finiteNumber(avg20) || avg20 <= 0) return;
    const ratio = row.volume / avg20;
    const item = {
      date: row.date,
      volume: row.volume,
      value: row.value ?? null,
      normalized_volume_20d: round(ratio, 4),
    };
    if (ratio >= 2) highVolumeDays.push(item);
    if (ratio >= 3) extremeVolumeDays.push(item);
    if (ratio <= 0.5) lowVolumeDays.push(item);
  });
  const normalizedVolume20d = finiteNumber(latestVolume) && avgVolume20 ? latestVolume / avgVolume20 : null;
  const normalizedValue20d = finiteNumber(latestValue) && avgValue20 ? latestValue / avgValue20 : null;
  return {
    observations_1y: tail.length,
    latest_volume: latestVolume,
    latest_value: latestValue,
    avg_volume_5d: averageVolume(rows, 5),
    avg_volume_20d: avgVolume20,
    avg_volume_60d: averageVolume(rows, 60),
    avg_volume_252d: averageVolume(rows, 252),
    avg_value_5d: averageValue(rows, 5),
    avg_value_20d: avgValue20,
    avg_value_60d: averageValue(rows, 60),
    avg_value_252d: averageValue(rows, 252),
    normalized_volume_20d: round(normalizedVolume20d, 4),
    normalized_value_20d: round(normalizedValue20d, 4),
    volume_percentile_1y: percentileOfValue(volumes1y, latestVolume),
    value_percentile_1y: percentileOfValue(values1y, latestValue),
    high_volume_days_1y: highVolumeDays.length,
    extreme_volume_days_1y: extremeVolumeDays.length,
    low_volume_days_1y: lowVolumeDays.length,
    recent_high_volume_days: highVolumeDays.slice(-10),
    participation_label: participationLabel({
      latestVolumePercentile: percentileOfValue(volumes1y, latestVolume),
      normalizedVolume20d,
      normalizedValue20d,
    }),
    interpretation_guardrail: "Volume participation chỉ đo mức tham gia giao dịch tương đối so với lịch sử của chính mã; không phải tín hiệu mua bán.",
  };
}

function volumeDataReliabilityProfile(rows = [], data = {}, factorConfidence = {}) {
  const tail = rows.slice(-252);
  const rowsWithVolume = rows.filter(row => Object.prototype.hasOwnProperty.call(row, "volume"));
  const rowsWithValue = rows.filter(row => Object.prototype.hasOwnProperty.call(row, "value"));
  const zeroVolumeDays = rows.filter(row => Number(row.volume || 0) <= 0).map(row => row.date);
  const missingVolumeDays = rows.filter(row => !finiteNumber(row.volume)).map(row => row.date);
  const missingValueDays = rows.filter(row => !finiteNumber(row.value)).map(row => row.date);
  const suspectSpikeDays = [];
  const priceShockNoVolumeDays = [];
  rows.forEach((row, index) => {
    const avg20 = movingAverageBefore(rows, index, "volume", 20);
    const prev = rows[index - 1];
    const ret = prev?.close > 0 && row.close > 0 ? (row.close / prev.close - 1) * 100 : null;
    if (finiteNumber(row.volume) && finiteNumber(avg20) && avg20 > 0) {
      const ratio = row.volume / avg20;
      if (ratio >= 8) {
        suspectSpikeDays.push({
          date: row.date,
          volume: row.volume,
          value: row.value ?? null,
          normalized_volume_20d: round(ratio, 4),
          ret_pct: round(ret),
        });
      }
      if (finiteNumber(ret) && Math.abs(ret) >= 5 && ratio <= 0.5) {
        priceShockNoVolumeDays.push({
          date: row.date,
          ret_pct: round(ret),
          volume: row.volume,
          normalized_volume_20d: round(ratio, 4),
        });
      }
    }
  });
  const factorResolved = data.data_basis?.factor_chain_resolved === true
    || data.data_basis?.adjusted_ohlcv_recomputed === true
    || factorConfidence.factor_chain_resolved === true
    || factorConfidence.adjusted_ohlcv_recomputed === true;
  const failures = [];
  if (!rows.length) failures.push("missing_series");
  if (rowsWithVolume.length < rows.length) failures.push("missing_volume_fields");
  if (rowsWithValue.length < rows.length) failures.push("missing_value_fields");
  if (zeroVolumeDays.length) failures.push("zero_volume_days_present");
  if (missingVolumeDays.length) failures.push("missing_volume_days_present");
  if (missingValueDays.length) failures.push("missing_value_days_present");
  if (suspectSpikeDays.length) failures.push("extreme_volume_spikes_need_review");
  const status = failures.length ? "review_needed" : "usable";
  return {
    observations: rows.length,
    observations_1y: tail.length,
    volume_field_coverage_pct: rows.length ? round(rowsWithVolume.length / rows.length * 100, 2) : 0,
    value_field_coverage_pct: rows.length ? round(rowsWithValue.length / rows.length * 100, 2) : 0,
    zero_volume_days: zeroVolumeDays.length,
    missing_volume_days: missingVolumeDays.length,
    missing_value_days: missingValueDays.length,
    suspect_spike_days: suspectSpikeDays.slice(-20),
    suspect_spike_count: suspectSpikeDays.length,
    price_shock_without_volume_count: priceShockNoVolumeDays.length,
    price_shock_without_volume_days: priceShockNoVolumeDays.slice(-20),
    corporate_action_volume_caveat: factorResolved
      ? "Factor chain đã được đánh dấu resolved/recomputed; vẫn cần kiểm tra volume quanh ngày sự kiện nếu có."
      : "Factor chain chưa hoàn chỉnh; spike volume/value quanh corporate action cần được đọc như dữ liệu cần guardrail.",
    volume_data_status: status,
    reliability_flags: failures,
    interpretation_guardrail: "Volume reliability chỉ kiểm tra tính đầy đủ và bất thường cơ học của dữ liệu ngày; không xác nhận sổ lệnh, dark pool, block trade hoặc dữ liệu intraday.",
  };
}

function vpciRows(rows = [], shortWindow = 20, longWindow = 100) {
  const out = [];
  rows.forEach((row, index) => {
    const smaShort = smaAt(rows, index, "close", shortWindow);
    const smaLong = smaAt(rows, index, "close", longWindow);
    const vwmaShort = vwmaAt(rows, index, "close", shortWindow);
    const vwmaLong = vwmaAt(rows, index, "close", longWindow);
    const avgVolumeShort = smaAt(rows, index, "volume", shortWindow);
    const avgVolumeLong = smaAt(rows, index, "volume", longWindow);
    const vpc = finiteNumber(vwmaLong) && finiteNumber(smaLong) ? vwmaLong - smaLong : null;
    const vpr = finiteNumber(vwmaShort) && finiteNumber(smaShort) && smaShort !== 0 ? vwmaShort / smaShort : null;
    const vm = finiteNumber(avgVolumeShort) && finiteNumber(avgVolumeLong) && avgVolumeLong > 0 ? avgVolumeShort / avgVolumeLong : null;
    const vpci = [vpc, vpr, vm].every(finiteNumber) ? vpc * vpr * vm : null;
    out.push({
      date: row.date,
      close: row.close ?? null,
      volume: row.volume ?? null,
      sma_short: round(smaShort, 4),
      sma_long: round(smaLong, 4),
      vwma_short: round(vwmaShort, 4),
      vwma_long: round(vwmaLong, 4),
      volume_ratio_short_long: round(vm, 4),
      value: round(vpci, 6),
    });
  });
  return out;
}

function confirmationLabel({ vpciLatest, vpciChange20d, priceVsSmaLongPct, volumeRatio }) {
  const enough = [vpciLatest, priceVsSmaLongPct, volumeRatio].filter(finiteNumber).length >= 2;
  if (!enough) return "chưa đủ dữ liệu";
  if (vpciLatest > 0 && (vpciChange20d ?? 0) >= 0 && priceVsSmaLongPct >= 0 && volumeRatio >= 0.8) return "giá-volume cùng xác nhận";
  if (vpciLatest < 0 && (vpciChange20d ?? 0) <= 0 && priceVsSmaLongPct <= 0 && volumeRatio >= 0.8) return "giá-volume cùng suy yếu";
  if (priceVsSmaLongPct >= 0 && vpciLatest <= 0) return "giá đi trước volume";
  if (priceVsSmaLongPct <= 0 && vpciLatest >= 0) return "volume không cùng chiều giá";
  return "hỗn hợp";
}

function volumePriceConfirmationProfile(rows = []) {
  const shortWindow = 20;
  const longWindow = 100;
  const series = vpciRows(rows, shortWindow, longWindow);
  const valid = series.filter(row => finiteNumber(row.value));
  const latest = series.at(-1) || {};
  const latestValid = valid.at(-1) || {};
  const smoothed = weightedMean(valid.slice(-shortWindow).map(row => ({
    value: row.value,
    weight: row.volume,
  })));
  const latestClose = rows.at(-1)?.close ?? null;
  const priceVsSmaShort = finiteNumber(latestClose) && finiteNumber(latest.sma_short) && latest.sma_short !== 0
    ? (latestClose / latest.sma_short - 1) * 100
    : null;
  const priceVsSmaLong = finiteNumber(latestClose) && finiteNumber(latest.sma_long) && latest.sma_long !== 0
    ? (latestClose / latest.sma_long - 1) * 100
    : null;
  const vpciChange20d = lineChangePct(valid, 20);
  const label = confirmationLabel({
    vpciLatest: latestValid.value,
    vpciChange20d,
    priceVsSmaLongPct: priceVsSmaLong,
    volumeRatio: latest.volume_ratio_short_long,
  });
  return {
    methodology: "VPCI/VWMA/SMA daily OHLCV, fixed windows 20/100",
    short_window: shortWindow,
    long_window: longWindow,
    observations: rows.length,
    valid_observations: valid.length,
    latest_date: latest.date || null,
    latest_close: latestClose,
    sma_20: latest.sma_short ?? null,
    sma_100: latest.sma_long ?? null,
    vwma_20: latest.vwma_short ?? null,
    vwma_100: latest.vwma_long ?? null,
    volume_ratio_20_100: latest.volume_ratio_short_long ?? null,
    price_vs_sma20_pct: round(priceVsSmaShort, 4),
    price_vs_sma100_pct: round(priceVsSmaLong, 4),
    vpci_latest: latestValid.value ?? null,
    vpci_smoothed_20d: round(smoothed, 6),
    vpci_20d_change_pct: round(vpciChange20d, 4),
    vpci_percentile_1y: percentileOfValue(valid.slice(-252).map(row => row.value), latestValid.value),
    confirmation_label: label,
    recent_vpci_points: valid.slice(-20).map(row => ({ date: row.date, vpci: row.value, volume_ratio_20_100: row.volume_ratio_short_long })),
    interpretation_guardrail: "SP22 dùng VPCI/VWMA/SMA để mô tả mức đồng thuận giữa giá và volume; không phải tín hiệu giao dịch hay dự báo giá.",
  };
}

function cumulativeObvVptRows(rows = []) {
  const out = [];
  let obv = 0;
  let vpt = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1];
    const row = rows[index];
    if (!(prev.close > 0) || !(row.close > 0) || !finiteNumber(row.volume)) continue;
    const ret = row.close / prev.close - 1;
    if (row.close > prev.close) obv += row.volume;
    if (row.close < prev.close) obv -= row.volume;
    vpt += row.volume * ret;
    out.push({
      date: row.date,
      value: row.value ?? null,
      volume: row.volume,
      ret_pct: ret * 100,
      obv,
      vpt,
    });
  }
  return out;
}

function cmfAt(rows = [], index, window = 20) {
  const sample = rows.slice(index - window + 1, index + 1)
    .filter(row => finiteNumber(row.high) && finiteNumber(row.low) && finiteNumber(row.close) && finiteNumber(row.volume) && row.volume > 0);
  if (sample.length < Math.max(5, Math.floor(window * 0.5))) return null;
  const volumeSum = sum(sample.map(row => row.volume));
  if (!volumeSum) return null;
  const flowSum = sample.reduce((total, row) => {
    const range = row.high - row.low;
    if (!finiteNumber(range) || range === 0) return total;
    const multiplier = ((row.close - row.low) - (row.high - row.close)) / range;
    return total + multiplier * row.volume;
  }, 0);
  return flowSum / volumeSum;
}

function cmfSeries(rows = [], window = 20) {
  return rows.map((row, index) => ({ date: row.date, value: cmfAt(rows, index, window), volume: row.volume ?? null }))
    .filter(row => finiteNumber(row.value));
}

function moneyFlowLabel({ cmf20, cmf60, vptChange20d, obvChange20d }) {
  const positiveCount = [cmf20, cmf60, vptChange20d, obvChange20d].filter(value => finiteNumber(value) && value > 0).length;
  const negativeCount = [cmf20, cmf60, vptChange20d, obvChange20d].filter(value => finiteNumber(value) && value < 0).length;
  if (positiveCount + negativeCount < 2) return "chưa đủ dữ liệu";
  if (positiveCount >= 3 && (cmf20 ?? 0) > 0.03 && (cmf60 ?? 0) >= 0) return "áp lực tiền dương";
  if (negativeCount >= 3 && (cmf20 ?? 0) < -0.03 && (cmf60 ?? 0) <= 0) return "áp lực tiền âm";
  if (positiveCount >= 3 && (!finiteNumber(cmf20) || cmf20 >= 0) && (!finiteNumber(cmf60) || cmf60 >= -0.03)) return "nghiêng dương nhưng yếu";
  if (negativeCount >= 3 && (!finiteNumber(cmf20) || cmf20 <= 0) && (!finiteNumber(cmf60) || cmf60 <= 0.03)) return "nghiêng âm nhưng yếu";
  return "hỗn hợp";
}

function moneyFlowPressureProfile(rows = []) {
  const cumulative = cumulativeObvVptRows(rows);
  const cmf20Series = cmfSeries(rows, 20);
  const cmf60Series = cmfSeries(rows, 60);
  const latest = cumulative.at(-1) || {};
  const cmf20 = cmf20Series.at(-1)?.value ?? null;
  const cmf60 = cmf60Series.at(-1)?.value ?? null;
  const vptChange20d = lineChangePct(cumulative.map(row => ({ value: row.vpt })), 20);
  const obvChange20d = lineChangePct(cumulative.map(row => ({ value: row.obv })), 20);
  const label = moneyFlowLabel({ cmf20, cmf60, vptChange20d, obvChange20d });
  const tail = cumulative.slice(-252);
  return {
    methodology: "OBV, VPT, CMF daily OHLCV, fixed windows 20/60",
    observations: rows.length,
    valid_observations: cumulative.length,
    latest_date: latest.date || rows.at(-1)?.date || null,
    obv_latest: round(latest.obv, 0),
    vpt_latest: round(latest.vpt, 4),
    obv_20d_change_pct: round(obvChange20d, 4),
    vpt_20d_change_pct: round(vptChange20d, 4),
    cmf_20d: round(cmf20, 4),
    cmf_60d: round(cmf60, 4),
    cmf_20d_percentile_1y: percentileOfValue(cmf20Series.slice(-252).map(row => row.value), cmf20),
    positive_flow_days_1y: tail.filter(row => row.ret_pct > 0 && finiteNumber(row.volume) && row.volume > 0).length,
    negative_flow_days_1y: tail.filter(row => row.ret_pct < 0 && finiteNumber(row.volume) && row.volume > 0).length,
    money_flow_label: label,
    recent_money_flow_points: cumulative.slice(-20).map(row => ({
      date: row.date,
      ret_pct: round(row.ret_pct, 4),
      volume: row.volume,
      obv: round(row.obv, 0),
      vpt: round(row.vpt, 4),
    })),
    interpretation_guardrail: "SP23 mô tả áp lực money flow từ OHLCV ngày; không thay thế dữ liệu intraday, block trade, sổ lệnh hoặc khuyến nghị giao dịch.",
  };
}

function effortResultObservationRows(rows = []) {
  const out = [];
  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1];
    const row = rows[index];
    if (!(prev.close > 0) || !(row.close > 0)) continue;
    const volumeAvg20 = movingAverageBefore(rows, index, "volume", 20);
    const valueAvg20 = movingAverageBefore(rows, index, "value", 20);
    const ret = (row.close / prev.close - 1) * 100;
    const range = finiteNumber(row.range_pct)
      ? row.range_pct
      : row.high && row.low && prev.close ? (row.high - row.low) / prev.close * 100 : null;
    const volumeRatio = finiteNumber(row.volume) && finiteNumber(volumeAvg20) && volumeAvg20 > 0 ? row.volume / volumeAvg20 : null;
    const valueRatio = finiteNumber(row.value) && finiteNumber(valueAvg20) && valueAvg20 > 0 ? row.value / valueAvg20 : null;
    const effort = [volumeRatio, valueRatio].filter(finiteNumber).length
      ? mean([volumeRatio, valueRatio].filter(finiteNumber))
      : null;
    const result = Math.max(
      finiteNumber(Math.abs(ret)) ? Math.abs(ret) : 0,
      finiteNumber(range) ? range : 0,
    );
    out.push({
      date: row.date,
      ret_pct: round(ret, 4),
      abs_ret_pct: round(Math.abs(ret), 4),
      range_pct: round(range, 4),
      volume: row.volume ?? null,
      value: row.value ?? null,
      normalized_volume_20d: round(volumeRatio, 4),
      normalized_value_20d: round(valueRatio, 4),
      effort_ratio: round(effort, 4),
      result_pct: round(result, 4),
      result_per_effort: finiteNumber(effort) && effort > 0 ? round(result / effort, 4) : null,
    });
  }
  return out;
}

function effortResultLabel({ lowResultCount, highResultCount, highEffortCount, latestEffort, latestResultPerEffort, medianResultPerEffort }) {
  if (!highEffortCount) return "chưa đủ high-effort events";
  const lowShare = lowResultCount / highEffortCount;
  const highShare = highResultCount / highEffortCount;
  if (finiteNumber(latestEffort) && latestEffort >= 2 && finiteNumber(latestResultPerEffort) && finiteNumber(medianResultPerEffort) && latestResultPerEffort <= medianResultPerEffort * 0.7) return "effort cao, result thấp";
  if (lowShare >= 0.45) return "thường có effort cao nhưng result thấp";
  if (highShare >= 0.45) return "effort cao thường đi cùng result lớn";
  return "effort-result hỗn hợp";
}

function effortResultProfile(rows = []) {
  const observations = effortResultObservationRows(rows);
  const tail = observations.slice(-252);
  const resultValues = tail.map(row => row.result_pct).filter(finiteNumber);
  const resultPerEffortValues = tail.map(row => row.result_per_effort).filter(finiteNumber);
  const resultMedian = median(resultValues);
  const resultP75 = quantile(resultValues, 0.75);
  const resultPerEffortMedian = median(resultPerEffortValues);
  const highEffortRows = tail.filter(row => finiteNumber(row.effort_ratio) && row.effort_ratio >= 2);
  const lowResultHighEffortRows = highEffortRows.filter(row => finiteNumber(row.result_pct) && finiteNumber(resultMedian) && row.result_pct <= resultMedian);
  const highResultHighEffortRows = highEffortRows.filter(row => finiteNumber(row.result_pct) && finiteNumber(resultP75) && row.result_pct >= resultP75);
  const latest = observations.at(-1) || {};
  return {
    methodology: "Effort = avg(normalized volume 20D, normalized value 20D); Result = max(abs return, intraday range)",
    observations_1y: tail.length,
    high_effort_days_1y: highEffortRows.length,
    low_result_high_effort_days_1y: lowResultHighEffortRows.length,
    high_result_high_effort_days_1y: highResultHighEffortRows.length,
    low_result_high_effort_share_pct: highEffortRows.length ? round(lowResultHighEffortRows.length / highEffortRows.length * 100) : null,
    high_result_high_effort_share_pct: highEffortRows.length ? round(highResultHighEffortRows.length / highEffortRows.length * 100) : null,
    median_result_pct_1y: round(resultMedian, 4),
    p75_result_pct_1y: round(resultP75, 4),
    median_result_per_effort_1y: round(resultPerEffortMedian, 4),
    latest_date: latest.date || null,
    latest_effort_ratio: latest.effort_ratio ?? null,
    latest_result_pct: latest.result_pct ?? null,
    latest_result_per_effort: latest.result_per_effort ?? null,
    effort_result_label: effortResultLabel({
      lowResultCount: lowResultHighEffortRows.length,
      highResultCount: highResultHighEffortRows.length,
      highEffortCount: highEffortRows.length,
      latestEffort: latest.effort_ratio,
      latestResultPerEffort: latest.result_per_effort,
      medianResultPerEffort: resultPerEffortMedian,
    }),
    recent_low_result_high_effort_days: lowResultHighEffortRows.slice(-10),
    recent_high_result_high_effort_days: highResultHighEffortRows.slice(-10),
    interpretation_guardrail: "SP24 đo effort-result từ dữ liệu ngày để nhận diện phiên nhiều giao dịch nhưng biến động/biên độ tương ứng thấp hoặc cao; không kết luận hấp thụ/cạn cung theo nghĩa tín hiệu.",
  };
}

function forwardReturn(rows = [], index, window) {
  const start = rows[index]?.close;
  const end = rows[index + window]?.close;
  if (!(start > 0) || !(end > 0)) return null;
  return (end / start - 1) * 100;
}

function pathStatsAfterEvent(rows = [], index, maxWindow = 20) {
  const start = rows[index]?.close;
  if (!(start > 0)) return { max_forward_return_pct: null, min_forward_return_pct: null };
  const path = rows.slice(index + 1, index + maxWindow + 1)
    .map(row => row.close > 0 ? (row.close / start - 1) * 100 : null)
    .filter(finiteNumber);
  return {
    max_forward_return_pct: path.length ? round(Math.max(...path), 4) : null,
    min_forward_return_pct: path.length ? round(Math.min(...path), 4) : null,
  };
}

function highVolumeEventRows(rows = [], threshold = 2) {
  const out = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const prev = rows[index - 1];
    const avg20 = movingAverageBefore(rows, index, "volume", 20);
    if (!finiteNumber(row.volume) || !finiteNumber(avg20) || avg20 <= 0 || !(prev.close > 0) || !(row.close > 0)) continue;
    const normalizedVolume = row.volume / avg20;
    if (normalizedVolume < threshold) continue;
    const sameDayReturn = (row.close / prev.close - 1) * 100;
    const path20 = pathStatsAfterEvent(rows, index, 20);
    out.push({
      date: row.date,
      close: row.close,
      volume: row.volume,
      value: row.value ?? null,
      normalized_volume_20d: round(normalizedVolume, 4),
      same_day_return_pct: round(sameDayReturn, 4),
      forward_return_5d_pct: round(forwardReturn(rows, index, 5), 4),
      forward_return_20d_pct: round(forwardReturn(rows, index, 20), 4),
      forward_return_60d_pct: round(forwardReturn(rows, index, 60), 4),
      ...path20,
    });
  }
  return out;
}

function forwardWindowStats(events = [], key) {
  const matured = events.filter(row => finiteNumber(row[key]));
  const values = matured.map(row => row[key]).filter(finiteNumber);
  return {
    matured_events: matured.length,
    median_pct: round(median(values), 4),
    p25_pct: round(quantile(values, 0.25), 4),
    p75_pct: round(quantile(values, 0.75), 4),
    positive_rate_pct: values.length ? round(values.filter(value => value > 0).length / values.length * 100) : null,
  };
}

function highVolumeBehaviorLabel(stats20 = {}, eventCount = 0) {
  if (eventCount < 5 || !Number.isFinite(stats20.matured_events) || stats20.matured_events < 5) return "chưa đủ high-volume events";
  if ((stats20.positive_rate_pct ?? 0) >= 60 && (stats20.median_pct ?? 0) > 0) return "sau volume cao thường giữ giá tốt hơn";
  if ((stats20.positive_rate_pct ?? 100) <= 40 && (stats20.median_pct ?? 0) < 0) return "sau volume cao thường suy yếu";
  return "hành vi sau volume cao hỗn hợp";
}

function highVolumeBehaviorProfile(rows = []) {
  const threshold = 2;
  const events = highVolumeEventRows(rows, threshold);
  const oneYearStart = rows.at(-252)?.date || rows[0]?.date || null;
  const events1y = oneYearStart ? events.filter(row => row.date >= oneYearStart) : events.slice(-252);
  const upEvents = events1y.filter(row => row.same_day_return_pct > 0);
  const downEvents = events1y.filter(row => row.same_day_return_pct < 0);
  const stats5 = forwardWindowStats(events, "forward_return_5d_pct");
  const stats20 = forwardWindowStats(events, "forward_return_20d_pct");
  const stats60 = forwardWindowStats(events, "forward_return_60d_pct");
  return {
    methodology: "High-volume event = volume >= 2x trailing 20D average; forward returns measured after event close",
    threshold_normalized_volume_20d: threshold,
    observations: rows.length,
    event_count_full_sample: events.length,
    event_count_1y: events1y.length,
    up_event_count_1y: upEvents.length,
    down_event_count_1y: downEvents.length,
    same_day_median_return_pct_1y: round(median(events1y.map(row => row.same_day_return_pct).filter(finiteNumber)), 4),
    forward_5d: stats5,
    forward_20d: stats20,
    forward_60d: stats60,
    post_high_volume_label: highVolumeBehaviorLabel(stats20, events.length),
    latest_high_volume_event: events.at(-1) || null,
    recent_high_volume_events: events.slice(-12),
    interpretation_guardrail: "SP25 là event study mô tả điều đã xảy ra sau các phiên volume cao; không dùng để dự báo phiên kế tiếp hoặc sinh tín hiệu mua bán.",
  };
}

function pviNviRows(rows = []) {
  const out = [];
  let pvi = 1000;
  let nvi = 1000;
  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1];
    const row = rows[index];
    if (!(prev.close > 0) || !(row.close > 0) || !finiteNumber(prev.volume) || !finiteNumber(row.volume)) continue;
    const ret = row.close / prev.close - 1;
    if (row.volume > prev.volume) pvi *= (1 + ret);
    if (row.volume < prev.volume) nvi *= (1 + ret);
    out.push({
      date: row.date,
      volume: row.volume,
      ret_pct: round(ret * 100, 4),
      pvi: round(pvi, 4),
      nvi: round(nvi, 4),
      volume_direction: row.volume > prev.volume ? "higher_volume" : row.volume < prev.volume ? "lower_volume" : "same_volume",
    });
  }
  return out;
}

function pviNviLabel({ pviChange20d, nviChange20d, pviNviRatio }) {
  const known = [pviChange20d, nviChange20d, pviNviRatio].filter(finiteNumber).length;
  if (known < 2) return "chưa đủ dữ liệu";
  if ((pviChange20d ?? 0) > 0 && (nviChange20d ?? 0) <= 0) return "high-volume participation nổi bật hơn";
  if ((nviChange20d ?? 0) > 0 && (pviChange20d ?? 0) <= 0) return "low-volume participation nổi bật hơn";
  if ((pviChange20d ?? 0) > 0 && (nviChange20d ?? 0) > 0) return "participation cùng chiều";
  if ((pviChange20d ?? 0) < 0 && (nviChange20d ?? 0) < 0) return "participation cùng suy yếu";
  return "participation hỗn hợp";
}

function pviNviParticipationProfile(rows = []) {
  const series = pviNviRows(rows);
  const latest = series.at(-1) || {};
  const pviChange20d = lineChangePct(series.map(row => ({ value: row.pvi })), 20);
  const nviChange20d = lineChangePct(series.map(row => ({ value: row.nvi })), 20);
  const pviChange60d = lineChangePct(series.map(row => ({ value: row.pvi })), 60);
  const nviChange60d = lineChangePct(series.map(row => ({ value: row.nvi })), 60);
  const pviNviRatio = finiteNumber(latest.pvi) && finiteNumber(latest.nvi) && latest.nvi !== 0 ? latest.pvi / latest.nvi : null;
  const tail = series.slice(-252);
  return {
    methodology: "PVI updates on higher-volume days; NVI updates on lower-volume days; base=1000",
    observations: series.length,
    latest_date: latest.date || null,
    pvi_latest: latest.pvi ?? null,
    nvi_latest: latest.nvi ?? null,
    pvi_nvi_ratio: round(pviNviRatio, 4),
    pvi_20d_change_pct: round(pviChange20d, 4),
    nvi_20d_change_pct: round(nviChange20d, 4),
    pvi_60d_change_pct: round(pviChange60d, 4),
    nvi_60d_change_pct: round(nviChange60d, 4),
    pvi_percentile_1y: percentileOfValue(tail.map(row => row.pvi), latest.pvi),
    nvi_percentile_1y: percentileOfValue(tail.map(row => row.nvi), latest.nvi),
    higher_volume_days_1y: tail.filter(row => row.volume_direction === "higher_volume").length,
    lower_volume_days_1y: tail.filter(row => row.volume_direction === "lower_volume").length,
    participation_regime_label: pviNviLabel({ pviChange20d, nviChange20d, pviNviRatio }),
    recent_pvi_nvi_points: tail.slice(-20).map(row => ({
      date: row.date,
      ret_pct: row.ret_pct,
      pvi: row.pvi,
      nvi: row.nvi,
      volume_direction: row.volume_direction,
    })),
    interpretation_guardrail: "SP26 dùng PVI/NVI để mô tả price change xảy ra nhiều hơn ở phiên volume tăng hay volume giảm; không phải tín hiệu giao dịch.",
  };
}

function typicalPrice(row = {}) {
  const values = [row.high, row.low, row.close].filter(finiteNumber);
  if (values.length >= 3) return mean(values);
  return finiteNumber(row.close) ? row.close : null;
}

function priceBinLabel(min, max) {
  return `${round(min, 2)}-${round(max, 2)}`;
}

function volumeAtPriceProfile(rows = []) {
  const window = 252;
  const binCount = 12;
  const tail = rows.slice(-1 * window)
    .map(row => ({ ...row, typical_price: typicalPrice(row) }))
    .filter(row => finiteNumber(row.typical_price) && finiteNumber(row.volume) && row.volume >= 0);
  const prices = tail.map(row => row.typical_price).filter(finiteNumber);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const span = finiteNumber(minPrice) && finiteNumber(maxPrice) ? Math.max(maxPrice - minPrice, 0) : null;
  const step = span && span > 0 ? span / binCount : null;
  const bins = Array.from({ length: binCount }, (_, index) => {
    const low = step ? minPrice + step * index : minPrice;
    const high = step ? (index === binCount - 1 ? maxPrice : minPrice + step * (index + 1)) : maxPrice;
    return {
      bin_index: index,
      price_low: round(low, 4),
      price_high: round(high, 4),
      price_mid: finiteNumber(low) && finiteNumber(high) ? round((low + high) / 2, 4) : null,
      price_bin: finiteNumber(low) && finiteNumber(high) ? priceBinLabel(low, high) : "—",
      days: 0,
      volume: 0,
      value: 0,
    };
  });
  for (const row of tail) {
    if (!step || !finiteNumber(row.typical_price)) continue;
    const rawIndex = Math.floor((row.typical_price - minPrice) / step);
    const index = Math.max(0, Math.min(binCount - 1, rawIndex));
    bins[index].days += 1;
    bins[index].volume += row.volume || 0;
    bins[index].value += row.value || 0;
  }
  const totalVolume = sum(bins.map(bin => bin.volume)) || 0;
  const totalValue = sum(bins.map(bin => bin.value)) || 0;
  const enrichedBins = bins.map(bin => ({
    ...bin,
    volume: round(bin.volume, 0),
    value: round(bin.value, 0),
    volume_share_pct: totalVolume ? round(bin.volume / totalVolume * 100, 2) : null,
    value_share_pct: totalValue ? round(bin.value / totalValue * 100, 2) : null,
  }));
  const pointOfControl = [...enrichedBins].sort((a, b) => (b.volume || 0) - (a.volume || 0))[0] || null;
  const topBins = [...enrichedBins].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 3);
  const latestClose = rows.at(-1)?.close ?? null;
  const currentBin = finiteNumber(latestClose) && step
    ? enrichedBins[Math.max(0, Math.min(binCount - 1, Math.floor((latestClose - minPrice) / step)))]
    : null;
  const concentrationTop3 = topBins.reduce((total, bin) => total + (bin.volume_share_pct || 0), 0);
  let acceptanceLabel = "chưa đủ dữ liệu";
  if (tail.length >= 60 && pointOfControl) {
    if (currentBin?.bin_index === pointOfControl.bin_index) acceptanceLabel = "giá hiện tại nằm trong vùng volume lớn nhất";
    else if (finiteNumber(latestClose) && finiteNumber(pointOfControl.price_mid) && latestClose > pointOfControl.price_mid) acceptanceLabel = "giá hiện tại nằm trên vùng volume lớn nhất";
    else if (finiteNumber(latestClose) && finiteNumber(pointOfControl.price_mid) && latestClose < pointOfControl.price_mid) acceptanceLabel = "giá hiện tại nằm dưới vùng volume lớn nhất";
    else acceptanceLabel = "volume-at-price hỗn hợp";
  }
  return {
    methodology: "Daily volume-at-price approximation: assigns each day volume/value to typical-price bins over trailing 252 sessions",
    window,
    bin_count: binCount,
    observations: tail.length,
    price_min: round(minPrice, 4),
    price_max: round(maxPrice, 4),
    total_volume: round(totalVolume, 0),
    total_value: round(totalValue, 0),
    point_of_control_bin: pointOfControl,
    current_price_bin: currentBin || null,
    top_volume_bins: topBins,
    volume_concentration_top3_pct: round(concentrationTop3, 2),
    acceptance_label: acceptanceLabel,
    bins: enrichedBins,
    interpretation_guardrail: "SP27 là xấp xỉ volume-at-price từ dữ liệu ngày; không thay thế volume profile intraday, order book hoặc phân bổ khớp lệnh thực tế trong phiên.",
  };
}

function returnDistributionProfile(rows = []) {
  const daily = dailyObservationRows(rows);
  const values = daily.map(row => row.ret_pct).filter(finiteNumber);
  const tail = daily.slice(-252);
  const oneYearValues = tail.map(row => row.ret_pct).filter(finiteNumber);
  const histogramBins = [
    { label: "<= -10%", min: -Infinity, max: -10 },
    { label: "-10% đến -5%", min: -10, max: -5 },
    { label: "-5% đến -2%", min: -5, max: -2 },
    { label: "-2% đến 0%", min: -2, max: 0 },
    { label: "0% đến 2%", min: 0, max: 2 },
    { label: "2% đến 5%", min: 2, max: 5 },
    { label: "5% đến 10%", min: 5, max: 10 },
    { label: "> 10%", min: 10, max: Infinity },
  ];
  const distributionStats = sample => ({
    observations: sample.length,
    mean_pct: round(mean(sample), 4),
    median_pct: round(median(sample), 4),
    std_pct: round(stdDev(sample), 4),
    p01_pct: round(quantile(sample, 0.01), 4),
    p05_pct: round(quantile(sample, 0.05), 4),
    p25_pct: round(quantile(sample, 0.25), 4),
    p75_pct: round(quantile(sample, 0.75), 4),
    p95_pct: round(quantile(sample, 0.95), 4),
    p99_pct: round(quantile(sample, 0.99), 4),
    iqr_pct: round(quantile(sample, 0.75) - quantile(sample, 0.25), 4),
    skewness: round(skewness(sample), 4),
    excess_kurtosis: round(excessKurtosis(sample), 4),
    positive_day_rate_pct: sample.length ? round(sample.filter(value => value > 0).length / sample.length * 100) : null,
  });
  return {
    full_sample: distributionStats(values),
    one_year: distributionStats(oneYearValues),
    one_year_histogram: histogramBins.map(bin => ({
      label: bin.label,
      count: oneYearValues.filter(value => value > bin.min && value <= bin.max).length,
    })),
    interpretation_guardrail: "Phân phối lợi suất là thống kê mô tả quá khứ; không giả định phân phối chuẩn và không dự báo lợi suất tương lai.",
  };
}

function tailRiskProfile(rows = []) {
  const daily = dailyObservationRows(rows);
  const tail = daily.slice(-252);
  const values = tail.map(row => row.ret_pct).filter(finiteNumber);
  const q05 = quantile(values, 0.05);
  const q01 = quantile(values, 0.01);
  const es05 = mean(values.filter(value => value <= q05));
  const es01 = mean(values.filter(value => value <= q01));
  const rolling21 = rollingReturnSeries(rows, 21).map(row => row.value).filter(finiteNumber);
  const rolling63 = rollingReturnSeries(rows, 63).map(row => row.value).filter(finiteNumber);
  return {
    observations_1y: values.length,
    historical_var_95_1d_pct: finiteNumber(q05) ? round(Math.abs(q05), 4) : null,
    historical_var_99_1d_pct: finiteNumber(q01) ? round(Math.abs(q01), 4) : null,
    expected_shortfall_95_1d_pct: finiteNumber(es05) ? round(Math.abs(es05), 4) : null,
    expected_shortfall_99_1d_pct: finiteNumber(es01) ? round(Math.abs(es01), 4) : null,
    down_5pct_days_1y: values.filter(value => value <= -5).length,
    down_10pct_days_1y: values.filter(value => value <= -10).length,
    rolling_21d_p05_pct: round(quantile(rolling21, 0.05)),
    rolling_63d_p05_pct: round(quantile(rolling63, 0.05)),
    worst_loss_days_1y: [...tail].filter(row => finiteNumber(row.ret_pct)).sort((a, b) => a.ret_pct - b.ret_pct).slice(0, 5),
    interpretation_guardrail: "Tail risk dùng lịch sử đã quan sát; VaR/ES ở đây là mô tả historical, không phải mô hình rủi ro giao dịch.",
  };
}

function longestRun(rows = [], predicate = () => false) {
  let best = 0;
  let current = 0;
  for (const row of rows) {
    if (predicate(row)) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

function liquidityRiskProfile(rows = []) {
  const tail = rows.slice(-252);
  const values = tail.map(row => row.value).filter(value => finiteNumber(value) && value >= 0);
  const latest = rows.at(-1) || {};
  const avg20 = averageValue(rows, 20);
  const avg60 = averageValue(rows, 60);
  const med252 = median(values);
  const droughtThreshold = finiteNumber(med252) ? med252 * 0.5 : null;
  const severeThreshold = finiteNumber(med252) ? med252 * 0.2 : null;
  const capacity20 = finiteNumber(avg20) ? avg20 * 0.1 : null;
  const capacity60 = finiteNumber(avg60) ? avg60 * 0.1 : null;
  const daysToTrade = notional => ({
    notional,
    at_10pct_adv20_days: capacity20 ? round(notional / capacity20, 2) : null,
    at_10pct_adv60_days: capacity60 ? round(notional / capacity60, 2) : null,
  });
  const zeroVolumeDays = tail.filter(row => Number(row.volume || 0) <= 0).length;
  const thinDays = finiteNumber(severeThreshold) ? tail.filter(row => finiteNumber(row.value) && row.value <= severeThreshold).length : 0;
  const droughtDays = finiteNumber(droughtThreshold) ? tail.filter(row => finiteNumber(row.value) && row.value <= droughtThreshold).length : 0;
  let riskLabel = "trung bình";
  if (zeroVolumeDays > 5 || thinDays >= 40 || (finiteNumber(avg20) && finiteNumber(med252) && avg20 < med252 * 0.4)) riskLabel = "cao";
  if (zeroVolumeDays === 0 && thinDays < 10 && finiteNumber(avg20) && finiteNumber(med252) && avg20 >= med252 * 0.8) riskLabel = "thấp";
  return {
    observations_1y: tail.length,
    latest_value: latest.value ?? null,
    median_value_1y: round(med252, 0),
    avg_value_20d: avg20,
    avg_value_60d: avg60,
    latest_value_percentile_1y: percentileOfValue(values, latest.value),
    zero_volume_days_1y: zeroVolumeDays,
    value_drought_days_1y: droughtDays,
    severe_thin_value_days_1y: thinDays,
    longest_value_drought_run_1y: finiteNumber(droughtThreshold) ? longestRun(tail, row => finiteNumber(row.value) && row.value <= droughtThreshold) : 0,
    trade_capacity_scenarios: [daysToTrade(1_000_000_000), daysToTrade(5_000_000_000), daysToTrade(10_000_000_000)],
    liquidity_risk_label: riskLabel,
    interpretation_guardrail: "Rủi ro thanh khoản chỉ là stress test theo giá trị giao dịch lịch sử; không phản ánh sổ lệnh thời gian thực hoặc chi phí trượt giá thực tế.",
  };
}

function stableFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function publicationSnapshotProfile(payload = {}, data = {}) {
  const identity = payload.stock_identity || {};
  const confidence = payload.data_confidence_profile || {};
  const blocks = [
    "stock_identity",
    "price_behavior_profile",
    "volatility_profile",
    "drawdown_profile",
    "liquidity_profile",
    "relative_strength_profile",
    "dynamic_beta_profile",
    "correlation_profile",
    "regime_profile",
    "shock_gap_profile",
    "volume_price_profile",
    "corporate_action_profile",
    "index_membership_profile",
    "industry_peer_profile",
    "return_distribution_profile",
    "tail_risk_profile",
    "liquidity_risk_profile",
    "volume_participation_profile",
    "volume_price_confirmation_profile",
    "money_flow_pressure_profile",
    "effort_result_profile",
    "high_volume_behavior_profile",
    "pvi_nvi_participation_profile",
    "volume_at_price_profile",
    "volume_data_reliability_profile",
    "data_confidence_profile",
  ];
  const caveats = [
    confidence.adjusted_price?.guardrail,
    confidence.membership?.guardrail,
    confidence.classification?.guardrail,
  ].filter(Boolean);
  return {
    snapshot_id: `${identity.symbol || payload.symbol || "UNKNOWN"}-${identity.sample_end || "NA"}-${stableFingerprint({
      symbol: payload.symbol,
      sample_end: identity.sample_end,
      sample_size: identity.sample_size,
      data_basis: data.data_basis || null,
      membership_version: data.membership_version || null,
      classification_version: data.classification_version || null,
    })}`,
    as_of_date: identity.sample_end || null,
    generated_at: payload.generated_at || null,
    artifact_path: `stock_profiles/${payload.symbol}.json`,
    canonical_view: `index.html?view=stockHistory&stock=${payload.symbol}&index=VN30`,
    block_count: blocks.filter(block => payload[block]).length,
    included_blocks: blocks.filter(block => payload[block]),
    publication_mode: caveats.length ? "publish_with_guardrails" : "publishable",
    visible_caveats: caveats,
    language_policy: "neutral_descriptive_non_advice",
  };
}

function profileReadinessProfile(payload = {}) {
  const blockChecks = [
    ["price_behavior_profile", payload.price_behavior_profile?.rolling_returns?.length >= 4],
    ["volatility_profile", finiteNumber(payload.volatility_profile?.hv60_pct)],
    ["drawdown_profile", finiteNumber(payload.drawdown_profile?.current_drawdown_pct)],
    ["liquidity_profile", finiteNumber(payload.liquidity_profile?.avg_value_20d)],
    ["relative_strength_profile", Array.isArray(payload.relative_strength_profile?.comparisons) && payload.relative_strength_profile.comparisons.length > 0],
    ["regime_profile", Array.isArray(payload.regime_profile?.behavior_by_market_regime)],
    ["shock_gap_profile", finiteNumber(payload.shock_gap_profile?.shock_5pct_count_1y)],
    ["volume_price_profile", Object.prototype.hasOwnProperty.call(payload.volume_price_profile || {}, "up_down_value_ratio_1y")],
    ["corporate_action_profile", Object.prototype.hasOwnProperty.call(payload.corporate_action_profile || {}, "global_unresolved_rows")],
    ["index_membership_profile", Array.isArray(payload.index_membership_profile?.current_memberships)],
    ["industry_peer_profile", Object.prototype.hasOwnProperty.call(payload.industry_peer_profile || {}, "peer_count")],
    ["return_distribution_profile", finiteNumber(payload.return_distribution_profile?.one_year?.observations)],
    ["tail_risk_profile", Object.prototype.hasOwnProperty.call(payload.tail_risk_profile || {}, "historical_var_95_1d_pct")],
    ["liquidity_risk_profile", Object.prototype.hasOwnProperty.call(payload.liquidity_risk_profile || {}, "liquidity_risk_label")],
    ["volume_participation_profile", Object.prototype.hasOwnProperty.call(payload.volume_participation_profile || {}, "participation_label")],
    ["volume_price_confirmation_profile", Object.prototype.hasOwnProperty.call(payload.volume_price_confirmation_profile || {}, "confirmation_label")],
    ["money_flow_pressure_profile", Object.prototype.hasOwnProperty.call(payload.money_flow_pressure_profile || {}, "money_flow_label")],
    ["effort_result_profile", Object.prototype.hasOwnProperty.call(payload.effort_result_profile || {}, "effort_result_label")],
    ["high_volume_behavior_profile", Object.prototype.hasOwnProperty.call(payload.high_volume_behavior_profile || {}, "post_high_volume_label")],
    ["pvi_nvi_participation_profile", Object.prototype.hasOwnProperty.call(payload.pvi_nvi_participation_profile || {}, "participation_regime_label")],
    ["volume_at_price_profile", Object.prototype.hasOwnProperty.call(payload.volume_at_price_profile || {}, "acceptance_label")],
    ["volume_data_reliability_profile", Object.prototype.hasOwnProperty.call(payload.volume_data_reliability_profile || {}, "volume_data_status")],
    ["publication_snapshot_profile", Boolean(payload.publication_snapshot_profile?.snapshot_id)],
  ];
  const passed = blockChecks.filter(([, ok]) => ok).length;
  const confidence = payload.data_confidence_profile || {};
  const blockers = [];
  if (confidence.adjusted_price?.status !== "verified") blockers.push("adjusted_price_factor_chain_guardrail");
  if (confidence.membership?.status !== "point_in_time_ready") blockers.push("membership_snapshot_only");
  if (confidence.classification?.status !== "point_in_time_ready") blockers.push("classification_snapshot_only");
  return {
    checks_passed: passed,
    checks_total: blockChecks.length,
    completion_pct: blockChecks.length ? round(passed / blockChecks.length * 100) : null,
    status: blockers.length ? "guardrailed_complete" : "complete",
    guardrail_count: blockers.length,
    guardrail_ids: blockers,
    block_checks: blockChecks.map(([id, ok]) => ({ id, status: ok ? "pass" : "fail" })),
    interpretation_guardrail: "Readiness đo độ đầy đủ hồ sơ trong phạm vi dữ liệu hiện có; các guardrail dữ liệu ngoài vẫn được giữ riêng.",
  };
}

function corporateActionProfile(data = {}, row = {}, factorConfidence = {}, factorQueue = {}) {
  const symbol = safeSymbol(row.symbol || row.ticker);
  const top = (factorConfidence.factor_unresolved_top_symbols || []).find(item => safeSymbol(item.symbol) === symbol);
  const queueRows = (factorQueue.rows || []).filter(item => safeSymbol(item.symbol) === symbol);
  return {
    adjustment_status: data.data_basis?.adjustment || factorConfidence.adjustment_status || "unknown",
    price_basis: data.data_basis?.price || factorConfidence.price_basis || "unknown",
    factor_chain_available: Boolean(factorConfidence.factor_chain_available),
    factor_chain_resolved: Boolean(factorConfidence.factor_chain_resolved),
    adjusted_ohlcv_recomputed: Boolean(factorConfidence.adjusted_ohlcv_recomputed),
    global_factor_rows: Number(factorConfidence.factor_total_rows || 0),
    global_resolved_rows: Number(factorConfidence.factor_resolved_rows || 0),
    global_unresolved_rows: Number(factorConfidence.factor_unresolved_rows || 0),
    symbol_unresolved_rows: Number(top?.rows || queueRows.length || 0),
    symbol_unresolved_queue_sample: queueRows.slice(0, 10),
    unresolved_event_type_counts: factorConfidence.factor_unresolved_event_type_counts || {},
    required_next_dataset: factorConfidence.required_next_dataset || "complete_resolved_corporate_action_factor_chain_and_recomputed_adjusted_ohlcv",
    guardrail: factorConfidence.guardrail || data.data_basis?.adjustment_guardrail || "Chưa có factor chain hoàn chỉnh để tự tái tính adjusted OHLCV.",
  };
}

function indexMembershipProfile(data = {}, row = {}) {
  const membership = data.membership_version || {};
  const memberships = Array.isArray(row.index_memberships) ? row.index_memberships.map(safeSymbol) : [];
  const counts = membership.index_member_counts || {};
  return {
    current_memberships: memberships,
    membership_count: memberships.length,
    membership_mode: membership.mode || "current_snapshot",
    point_in_time_ready: Boolean(membership.point_in_time_ready),
    history_maturity: membership.history_maturity || "unknown",
    effective_date_count: Number(membership.history_status?.effective_date_count || 0),
    active_rows: Number(membership.history_status?.active_rows || 0),
    closed_rows: Number(membership.history_status?.closed_rows || 0),
    index_member_counts: Object.fromEntries(memberships.map(id => [id, counts[id] ?? null])),
    primary_sector_proxy: memberships.find(id => sectorIndexProxies.includes(id)) || null,
    next_required_dataset: membership.next_required_dataset || "index_membership_history(index_code, ticker, effective_from, effective_to)",
    guardrail: membership.guardrail || "Membership đang đọc theo snapshot hiện tại.",
  };
}

function percentileInPeer(rows = [], value, key) {
  const values = rows.map(row => row[key]).filter(finiteNumber);
  return percentileOfValue(values, value);
}

function industryPeerProfile(data = {}, row = {}, stocks = []) {
  const memberships = Array.isArray(row.index_memberships) ? row.index_memberships.map(safeSymbol) : [];
  const sectorProxy = memberships.find(id => sectorIndexProxies.includes(id)) || null;
  const industryGroup = row.industry_group || row.industry || "";
  const hasUsableIndustry = Boolean(industryGroup && industryGroup.trim());
  const peers = hasUsableIndustry
    ? stocks.filter(item => (item.industry_group || item.industry || "") === industryGroup)
    : sectorProxy
      ? stocks.filter(item => Array.isArray(item.index_memberships) && item.index_memberships.map(safeSymbol).includes(sectorProxy))
      : [];
  return {
    industry_group: industryGroup || null,
    primary_peer_basis: hasUsableIndustry ? "industry_group" : sectorProxy ? "sector_index_proxy" : "unavailable",
    primary_sector_proxy: sectorProxy,
    peer_count: peers.length,
    peer_return_60_median_pct: round(median(peers.map(item => item.ret_60d).filter(finiteNumber))),
    peer_return_252_median_pct: round(median(peers.map(item => item.ret_252d).filter(finiteNumber))),
    peer_volatility_60_median_pct: round(median(peers.map(item => item.volatility_60d).filter(finiteNumber))),
    peer_avg_value_20_median: round(median(peers.map(item => item.avg_value_20d).filter(finiteNumber)), 0),
    return_60_percentile: percentileInPeer(peers, row.ret_60d, "ret_60d"),
    return_252_percentile: percentileInPeer(peers, row.ret_252d, "ret_252d"),
    volatility_60_percentile: percentileInPeer(peers, row.volatility_60d, "volatility_60d"),
    liquidity_20_percentile: percentileInPeer(peers, row.avg_value_20d, "avg_value_20d"),
    guardrail: hasUsableIndustry
      ? "Peer ngành dùng phân loại hiện tại, chưa phải lịch sử point-in-time."
      : sectorProxy
        ? `Phân ngành hiện tại thiếu; dùng ${sectorProxy} như proxy nhóm ngành/rổ hiện tại.`
        : "Không có ngành hoặc sector proxy đủ tin cậy để lập peer profile.",
  };
}

function candidateBenchmarks(data = {}, row = {}) {
  const available = data.index_series || {};
  const memberships = Array.isArray(row.index_memberships) ? row.index_memberships.map(safeSymbol) : [];
  const orderedMemberships = [
    ...preferredMembershipBenchmarks.filter(id => memberships.includes(id)),
    ...memberships.filter(id => !preferredMembershipBenchmarks.includes(id)),
  ];
  return Array.from(new Set([...mandatoryBenchmarks, ...orderedMemberships]))
    .filter(id => Array.isArray(available[id]) && available[id].length)
    .map(id => ({
      id,
      type: mandatoryBenchmarks.includes(id) ? "core" : "membership",
      label: id === "VNINDEX" ? "Thị trường" : memberships.includes(id) ? "Rổ hiện tại" : id,
    }));
}

function pairedRows(stockRows = [], benchmarkRows = []) {
  const benchmarkByDate = new Map(benchmarkRows.map(row => [row.date, row]));
  return stockRows
    .map(row => ({ date: row.date, stock: row, benchmark: benchmarkByDate.get(row.date) }))
    .filter(row => row.benchmark && finiteNumber(row.stock.close) && finiteNumber(row.benchmark.close));
}

function relationReturnPairs(paired = [], window = 252) {
  const rows = paired.slice(-1 * (window + 1));
  const out = [];
  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1];
    const cur = rows[index];
    if (!(prev.stock.close > 0) || !(prev.benchmark.close > 0)) continue;
    const stockRet = cur.stock.close / prev.stock.close - 1;
    const benchmarkRet = cur.benchmark.close / prev.benchmark.close - 1;
    if (finiteNumber(stockRet) && finiteNumber(benchmarkRet)) out.push({ date: cur.date, stockRet, benchmarkRet });
  }
  return out;
}

function corrFromPairs(pairs = [], leftKey = "stockRet", rightKey = "benchmarkRet") {
  if (pairs.length < 5) return null;
  const left = pairs.map(row => row[leftKey]).filter(finiteNumber);
  const right = pairs.map(row => row[rightKey]).filter(finiteNumber);
  if (left.length !== pairs.length || right.length !== pairs.length) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftVar = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
  const rightVar = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
  if (!leftVar || !rightVar) return null;
  return numerator / Math.sqrt(leftVar * rightVar);
}

function betaFromPairs(pairs = []) {
  if (pairs.length < 5) return null;
  const stockReturns = pairs.map(row => row.stockRet);
  const benchmarkReturns = pairs.map(row => row.benchmarkRet);
  const stockMean = mean(stockReturns);
  const benchmarkMean = mean(benchmarkReturns);
  const covariance = stockReturns.reduce((sum, value, index) => sum + (value - stockMean) * (benchmarkReturns[index] - benchmarkMean), 0) / (pairs.length - 1);
  const variance = benchmarkReturns.reduce((sum, value) => sum + (value - benchmarkMean) ** 2, 0) / (pairs.length - 1);
  return variance ? covariance / variance : null;
}

function cumulativeReturn(pairs = [], key) {
  if (!pairs.length) return null;
  return pairs.reduce((value, row) => value * (1 + row[key]), 1) - 1;
}

function benchmarkMetrics(paired = [], window = 252) {
  const pairs = relationReturnPairs(paired, window);
  if (pairs.length < Math.max(5, Math.floor(window * 0.5))) return null;
  const stockReturn = cumulativeReturn(pairs, "stockRet");
  const benchmarkReturn = cumulativeReturn(pairs, "benchmarkRet");
  const corr = corrFromPairs(pairs);
  const beta = betaFromPairs(pairs);
  const stockDd = drawdownSeriesFromRows(paired.slice(-1 * (window + 1)).map(row => row.stock));
  const benchmarkDd = drawdownSeriesFromRows(paired.slice(-1 * (window + 1)).map(row => row.benchmark));
  const ddPairs = stockDd.map((value, index) => ({ stockDd: value, benchmarkDd: benchmarkDd[index] }))
    .filter(row => finiteNumber(row.stockDd) && finiteNumber(row.benchmarkDd));
  return {
    window,
    observations: pairs.length,
    stock_return_pct: round(stockReturn * 100),
    benchmark_return_pct: round(benchmarkReturn * 100),
    relative_return_pct: stockReturn !== null && benchmarkReturn !== null ? round((stockReturn - benchmarkReturn) * 100) : null,
    correlation: round(corr, 4),
    beta: round(beta, 4),
    r2: finiteNumber(corr) ? round(corr * corr, 4) : null,
    hit_rate_pct: round(pairs.filter(row => row.stockRet > row.benchmarkRet).length / pairs.length * 100),
    stock_max_drawdown_pct: stockDd.length ? round(Math.min(...stockDd.filter(finiteNumber)) * 100) : null,
    benchmark_max_drawdown_pct: benchmarkDd.length ? round(Math.min(...benchmarkDd.filter(finiteNumber)) * 100) : null,
    drawdown_similarity: round(corrFromPairs(ddPairs, "stockDd", "benchmarkDd"), 4),
  };
}

function buildBenchmarkContexts(data = {}) {
  const out = {};
  const indexSeries = data.index_series || {};
  for (const [id, rawRows] of Object.entries(indexSeries)) {
    const rows = normalizedStockHistoryRows(Array.isArray(rawRows) ? rawRows : []);
    const returns = [];
    for (let index = 1; index < rows.length; index += 1) {
      const prev = rows[index - 1]?.close;
      const cur = rows[index]?.close;
      returns.push(prev > 0 && cur > 0 ? Math.log(cur / prev) : null);
    }
    const drawdowns = drawdownSeriesFromRows(rows);
    const rollingVol = [];
    const volPercentiles = [];
    for (let index = 0; index < returns.length; index += 1) {
      const sample = returns.slice(Math.max(0, index - 19), index + 1).filter(finiteNumber);
      const vol = sample.length >= 10 ? stdDev(sample) * Math.sqrt(252) : null;
      rollingVol.push(vol);
      const history = rollingVol.filter(finiteNumber);
      volPercentiles.push(history.length >= 60 && finiteNumber(vol) ? round(history.filter(value => value <= vol).length / history.length * 100) : null);
    }
    const byDate = new Map(rows.map((row, index) => {
      const r60 = index >= 60 && rows[index - 60]?.close > 0 ? row.close / rows[index - 60].close - 1 : null;
      const r120 = index >= 120 && rows[index - 120]?.close > 0 ? row.close / rows[index - 120].close - 1 : null;
      const drawdown = drawdowns[index];
      const volRank = volPercentiles[Math.max(0, index - 1)] ?? null;
      return [row.date, { ...row, regime: classifyRegime({ r60, r120, drawdown, volRank }) }];
    }));
    out[id] = { id, rows, byDate };
  }
  return out;
}

function classifyRegime({ r60, r120, drawdown, volRank }) {
  const pct = value => finiteNumber(value) ? round(value * 100) : null;
  if (!finiteNumber(r60) || !finiteNumber(r120) || !finiteNumber(drawdown)) return { id: "unknown", label: "chưa đủ dữ liệu", r60: pct(r60), r120: pct(r120), drawdown_pct: pct(drawdown), vol_rank: volRank };
  if (drawdown <= -0.18 || (r60 <= -0.12 && (volRank ?? 0) >= 75)) return { id: "stress", label: "stress", r60: round(r60 * 100), r120: round(r120 * 100), drawdown_pct: round(drawdown * 100), vol_rank: volRank };
  if (r60 > 0.06 && r120 > 0.08 && drawdown > -0.08) return { id: "uptrend", label: "uptrend", r60: round(r60 * 100), r120: round(r120 * 100), drawdown_pct: round(drawdown * 100), vol_rank: volRank };
  if (r60 > 0.04 && r120 <= 0.08 && drawdown > -0.14) return { id: "recovery", label: "phục hồi", r60: round(r60 * 100), r120: round(r120 * 100), drawdown_pct: round(drawdown * 100), vol_rank: volRank };
  return { id: "sideways", label: "sideways", r60: round(r60 * 100), r120: round(r120 * 100), drawdown_pct: round(drawdown * 100), vol_rank: volRank };
}

function regimeBehavior(paired = [], benchmarkContext = null) {
  if (!benchmarkContext) return [];
  const groups = new Map();
  for (let index = 1; index < paired.length; index += 1) {
    const prev = paired[index - 1];
    const cur = paired[index];
    if (!(prev.stock.close > 0) || !(prev.benchmark.close > 0)) continue;
    const context = benchmarkContext.byDate.get(cur.date);
    const regime = context?.regime || { id: "unknown", label: "chưa đủ dữ liệu" };
    if (regime.id === "unknown") continue;
    const stockRet = cur.stock.close / prev.stock.close - 1;
    const benchmarkRet = cur.benchmark.close / prev.benchmark.close - 1;
    if (!groups.has(regime.id)) groups.set(regime.id, { regime_id: regime.id, regime_label: regime.label, stock_returns: [], benchmark_returns: [] });
    const group = groups.get(regime.id);
    group.stock_returns.push(stockRet);
    group.benchmark_returns.push(benchmarkRet);
  }
  return [...groups.values()].map(group => {
    const pairedReturns = group.stock_returns.map((stockRet, index) => ({ stockRet, benchmarkRet: group.benchmark_returns[index] }));
    return {
      regime_id: group.regime_id,
      regime_label: group.regime_label,
      observations: group.stock_returns.length,
      stock_avg_daily_return_pct: round(mean(group.stock_returns) * 100, 4),
      benchmark_avg_daily_return_pct: round(mean(group.benchmark_returns) * 100, 4),
      relative_avg_daily_return_pct: round((mean(group.stock_returns) - mean(group.benchmark_returns)) * 100, 4),
      hit_rate_pct: round(group.stock_returns.filter((value, index) => value > group.benchmark_returns[index]).length / group.stock_returns.length * 100),
      beta: round(betaFromPairs(pairedReturns), 4),
      correlation: round(corrFromPairs(pairedReturns), 4),
    };
  }).sort((a, b) => a.regime_id.localeCompare(b.regime_id));
}

function benchmarkAndRegimeProfiles(data = {}, row = {}, rows = [], benchmarkContexts = {}) {
  const candidates = candidateBenchmarks(data, row);
  const comparisons = candidates.map(candidate => {
    const context = benchmarkContexts[candidate.id];
    const paired = pairedRows(rows, context?.rows || []);
    const metricsByWindow = Object.fromEntries([60, 120, 252].map(window => [String(window), benchmarkMetrics(paired, window)]));
    return {
      benchmark: candidate.id,
      type: candidate.type,
      label: candidate.label,
      paired_observations: paired.length,
      current_regime: context?.byDate?.get((context.rows || []).at(-1)?.date)?.regime || null,
      metrics: metricsByWindow,
      regime_behavior: candidate.id === "VNINDEX" ? regimeBehavior(paired, context) : [],
    };
  });
  const bestFit = comparisons
    .filter(item => finiteNumber(item.metrics?.["252"]?.r2))
    .sort((a, b) => (b.metrics["252"].r2 - a.metrics["252"].r2) || ((b.metrics["120"]?.r2 ?? -1) - (a.metrics["120"]?.r2 ?? -1)))[0] || null;
  const vnindex = comparisons.find(item => item.benchmark === "VNINDEX") || null;
  return {
    relative_strength_profile: {
      benchmark_set: candidates.map(item => item.id),
      best_fit_benchmark: bestFit ? { benchmark: bestFit.benchmark, r2_252: bestFit.metrics?.["252"]?.r2, relative_return_252_pct: bestFit.metrics?.["252"]?.relative_return_pct } : null,
      comparisons,
      interpretation_guardrail: "So sánh benchmark là mô tả lịch sử theo dữ liệu hiện có, không phải tín hiệu dự báo.",
    },
    dynamic_beta_profile: {
      primary_benchmark: "VNINDEX",
      beta_60: vnindex?.metrics?.["60"]?.beta ?? null,
      beta_120: vnindex?.metrics?.["120"]?.beta ?? null,
      beta_252: vnindex?.metrics?.["252"]?.beta ?? null,
      observations_252: vnindex?.metrics?.["252"]?.observations ?? 0,
    },
    correlation_profile: {
      primary_benchmark: "VNINDEX",
      corr_60: vnindex?.metrics?.["60"]?.correlation ?? null,
      corr_120: vnindex?.metrics?.["120"]?.correlation ?? null,
      corr_252: vnindex?.metrics?.["252"]?.correlation ?? null,
      r2_252: vnindex?.metrics?.["252"]?.r2 ?? null,
      drawdown_similarity_252: vnindex?.metrics?.["252"]?.drawdown_similarity ?? null,
    },
    regime_profile: {
      primary_benchmark: "VNINDEX",
      current_market_regime: vnindex?.current_regime || null,
      behavior_by_market_regime: vnindex?.regime_behavior || [],
      regime_guardrail: "Regime dùng trạng thái benchmark hiện có; không thay thế lịch sử thành phần point-in-time.",
    },
  };
}

function dataConfidence(data = {}, row = {}, rows = []) {
  const dataBasis = data.data_basis || {};
  const membership = data.membership_version || {};
  const classification = data.classification_version || {};
  const factorResolved = dataBasis.factor_chain_resolved === true || dataBasis.adjusted_ohlcv_recomputed === true;
  return {
    raw_price: {
      status: rows.length >= 252 ? "usable" : rows.length ? "thin_sample" : "missing",
      evidence: `${rows.length} phiên từ series artifact`,
    },
    adjusted_price: {
      status: factorResolved ? "verified" : "guardrailed",
      evidence: dataBasis.adjustment_status || "provider_adjusted_with_partial_factor_chain_not_applied",
      guardrail: dataBasis.adjustment_guardrail || "Chưa có factor chain hoàn chỉnh và bằng chứng recompute adjusted OHLCV.",
    },
    membership: {
      status: membership.point_in_time_ready ? "point_in_time_ready" : "snapshot_only",
      evidence: membership.history_maturity || membership.mode || "current_snapshot",
      guardrail: membership.guardrail || "Chưa có lịch sử rổ theo ngày hiệu lực.",
      current_memberships: Array.isArray(row.index_memberships) ? row.index_memberships : [],
    },
    classification: {
      status: classification.point_in_time_ready ? "point_in_time_ready" : "snapshot_only",
      evidence: classification.history_maturity || classification.mode || "current_snapshot",
      guardrail: classification.guardrail || "Phân ngành đang là snapshot hiện tại.",
      industry_group: row.industry_group || null,
    },
  };
}

function buildProfile({ data, row, rows, stocks, benchmarkContexts, factorConfidence, factorQueue }) {
  const symbol = safeSymbol(row.symbol || row.ticker);
  const normalized = normalizedStockHistoryRows(rows);
  const generatedAt = new Date().toISOString();
  const latest = normalized[normalized.length - 1] || {};
  const returns = dailyReturns(normalized);
  const drawdown = drawdownEpisodeProfile(normalized);
  const vol20History = realizedVolHistory(normalized, 20);
  const vol60History = realizedVolHistory(normalized, 60);
  const currentVol20 = realizedVol(normalized, 20);
  const currentVol60 = realizedVol(normalized, 60);
  const currentValue = latest.value ?? null;
  const value252 = normalized.slice(-252).map(item => item.value).filter(finiteNumber);
  const rollingReturns = [21, 63, 126, 252].map(window => rollingReturnProfile(normalized, window));
  const latestClose = latest.close ?? row.close ?? null;
  const high52w = Math.max(...normalized.slice(-252).map(item => item.high ?? item.close).filter(finiteNumber));
  const low52w = Math.min(...normalized.slice(-252).map(item => item.low ?? item.close).filter(finiteNumber));
  const currentDrawdownEpisodes = drawdown.episodes || [];
  const benchmarkProfiles = benchmarkAndRegimeProfiles(data, row, normalized, benchmarkContexts);
  const payload = {
    schema: "market-stats-stock-profile-foundation-v1",
    generated_at: generatedAt,
    symbol,
    stock_identity: {
      symbol,
      exchange: row.exchange || null,
      industry_group: row.industry_group || null,
      current_memberships: Array.isArray(row.index_memberships) ? row.index_memberships : [],
      data_quality: row.data_quality || null,
      sample_start: normalized[0]?.date || null,
      sample_end: normalized[normalized.length - 1]?.date || null,
      sample_size: normalized.length,
    },
    price_behavior_profile: {
      latest_close: latestClose,
      latest_date: latest.date || null,
      return_1m_pct: pctChange(normalized, 21),
      return_3m_pct: pctChange(normalized, 63),
      return_6m_pct: pctChange(normalized, 126),
      return_1y_pct: pctChange(normalized, 252),
      high_52w: finiteNumber(high52w) ? high52w : null,
      low_52w: finiteNumber(low52w) ? low52w : null,
      distance_from_52w_high_pct: high52w > 0 && latestClose > 0 ? round((latestClose / high52w - 1) * 100) : null,
      distance_from_52w_low_pct: low52w > 0 && latestClose > 0 ? round((latestClose / low52w - 1) * 100) : null,
      rolling_returns: rollingReturns,
      daily_return_distribution: {
        observations: returns.length,
        median_pct: round(median(returns)),
        p10_pct: round(quantile(returns, 0.1)),
        p90_pct: round(quantile(returns, 0.9)),
        ...thresholdCounts(returns),
      },
    },
    volatility_profile: {
      hv20_pct: currentVol20,
      hv60_pct: currentVol60,
      hv120_pct: realizedVol(normalized, 120),
      hv252_pct: realizedVol(normalized, 252),
      hv20_percentile_1y: percentileOfValue(vol20History.slice(-252), currentVol20),
      hv60_percentile_1y: percentileOfValue(vol60History.slice(-252), currentVol60),
      range_pct_median_63d: round(median(normalized.slice(-63).map(row => row.range_pct).filter(finiteNumber))),
      range_pct_p90_63d: round(quantile(normalized.slice(-63).map(row => row.range_pct).filter(finiteNumber), 0.9)),
    },
    drawdown_profile: {
      current_drawdown_pct: drawdown.current,
      current_underwater_days: drawdown.currentUnderwaterDays ?? null,
      max_drawdown_pct: drawdown.maxDepth,
      episode_count: currentDrawdownEpisodes.length,
      deep_drawdown_count_10_pct: currentDrawdownEpisodes.filter(item => item.depth <= -10).length,
      deep_drawdown_count_20_pct: currentDrawdownEpisodes.filter(item => item.depth <= -20).length,
      deep_drawdown_count_30_pct: currentDrawdownEpisodes.filter(item => item.depth <= -30).length,
      median_recovery_days: round(median(currentDrawdownEpisodes.map(item => item.recoveryDays).filter(finiteNumber)), 0),
      worst_episodes: currentDrawdownEpisodes.slice(0, 5),
      max_runup: maxRunupProfile(normalized),
    },
    liquidity_profile: {
      latest_volume: latest.volume ?? null,
      latest_value: currentValue,
      avg_volume_20d: averageVolume(normalized, 20),
      avg_volume_60d: averageVolume(normalized, 60),
      avg_value_20d: averageValue(normalized, 20),
      avg_value_60d: averageValue(normalized, 60),
      latest_value_percentile_1y: percentileOfValue(value252, currentValue),
      liquidity_stability_63d: liquidityStability(normalized, 63),
      volume_spike_days_1y: spikeDays(normalized, 252),
    },
    ...benchmarkProfiles,
    shock_gap_profile: shockGapProfile(normalized),
    volume_price_profile: volumePriceProfile(normalized),
    corporate_action_profile: corporateActionProfile(data, row, factorConfidence, factorQueue),
    index_membership_profile: indexMembershipProfile(data, row),
    industry_peer_profile: industryPeerProfile(data, row, stocks),
    return_distribution_profile: returnDistributionProfile(normalized),
    tail_risk_profile: tailRiskProfile(normalized),
    liquidity_risk_profile: liquidityRiskProfile(normalized),
    volume_participation_profile: volumeParticipationProfile(normalized),
    volume_price_confirmation_profile: volumePriceConfirmationProfile(normalized),
    money_flow_pressure_profile: moneyFlowPressureProfile(normalized),
    effort_result_profile: effortResultProfile(normalized),
    high_volume_behavior_profile: highVolumeBehaviorProfile(normalized),
    pvi_nvi_participation_profile: pviNviParticipationProfile(normalized),
    volume_at_price_profile: volumeAtPriceProfile(normalized),
    volume_data_reliability_profile: volumeDataReliabilityProfile(normalized, data, factorConfidence),
    data_confidence_profile: dataConfidence(data, row, normalized),
  };
  payload.publication_snapshot_profile = publicationSnapshotProfile(payload, data);
  payload.profile_readiness_profile = profileReadinessProfile(payload);
  return payload;
}

const data = readJson(dataPath, {});
const stocks = Array.isArray(data.stocks) ? data.stocks : [];
const factorConfidence = readJson(factorConfidencePath, {});
const factorQueue = readJson(factorQueuePath, {});
const benchmarkContexts = buildBenchmarkContexts(data);
const symbols = requestedSymbols.length
  ? requestedSymbols
  : stocks.map(row => safeSymbol(row.symbol || row.ticker)).filter(Boolean).sort((a, b) => a.localeCompare(b));
const rowBySymbol = new Map(stocks.map(row => [safeSymbol(row.symbol || row.ticker), row]));

fs.mkdirSync(outDir, { recursive: true });
let written = 0;
let missingSeries = 0;
for (const symbol of symbols) {
  const row = rowBySymbol.get(symbol) || { symbol };
  const rows = readJson(path.join(seriesDir, `${symbol}.json`), []);
  if (!Array.isArray(rows) || !rows.length) missingSeries += 1;
  const payload = buildProfile({ data, row, rows: Array.isArray(rows) ? rows : [], stocks, benchmarkContexts, factorConfidence, factorQueue });
  fs.writeFileSync(path.join(outDir, `${symbol}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  written += 1;
}

console.log(`stock_profiles: wrote ${written} file(s) missing_series=${missingSeries}`);
