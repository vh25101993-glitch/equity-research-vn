#!/usr/bin/env python3
"""Build lightweight current setup candidates for Market Stats.

This scanner only reads the latest stock_series JSON files and evaluates the
most recent price path. It is intentionally lightweight: it does not rescan the
full historical pattern corpus and it does not make trading recommendations.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STOCK_SERIES_DIR = ROOT / "market_stats" / "web" / "stock_series"
DEFAULT_OUT = ROOT / "market_stats" / "web" / "current_pattern_setups.json"


def run_generated_at() -> str:
    """UTC ISO timestamp (seconds) shared across all artifacts of one pipeline
    run. See generate_simple_stats.run_generated_at."""
    env_value = os.getenv("MARKET_STATS_RUN_AT", "").strip()
    if env_value:
        return env_value
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def finite(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def pct(a: float, b: float) -> float:
    return (a / b - 1) * 100 if b else 0.0


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def slope(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    n = len(values)
    x_mean = (n - 1) / 2
    y_mean = sum(values) / n
    denom = sum((i - x_mean) ** 2 for i in range(n)) or 1
    return sum((i - x_mean) * (value - y_mean) for i, value in enumerate(values)) / denom


def load_series(stock_series_dir: Path) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    if not stock_series_dir.is_dir():
        return out
    for path in sorted(stock_series_dir.glob("*.json")):
        symbol = path.stem.upper()
        if " " in symbol:
            continue
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        clean = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            close = finite(row.get("close"))
            high = finite(row.get("high"))
            low = finite(row.get("low"))
            if not row.get("date") or close is None or high is None or low is None:
                continue
            clean.append({**row, "close": close, "high": high, "low": low, "volume": finite(row.get("volume")) or 0.0})
        clean.sort(key=lambda row: str(row.get("date")))
        if len(clean) >= 40:
            out[symbol] = clean
    return out


def status_from_score(score: float, distance_pct: float | None, noisy: bool = False) -> str:
    if noisy:
        return "nhiễu"
    if score >= 78 and distance_pct is not None and distance_pct <= 3:
        return "gần xác nhận"
    if score >= 62:
        return "đang hình thành"
    return "chưa đủ sạch"


def setup(
    pattern_id: str,
    pattern_name: str,
    score: float,
    confirmation_price: float | None,
    watch_low: float | None,
    watch_high: float | None,
    current_close: float,
    caution: str,
    status: str | None = None,
) -> dict[str, Any] | None:
    score = round(clamp(score), 2)
    if score < 55:
        return None
    distance = None
    if confirmation_price:
        distance = max(0.0, pct(confirmation_price, current_close))
    return {
        "pattern_id": pattern_id,
        "pattern_name": pattern_name,
        "setup_status": status or status_from_score(score, distance),
        "completion_score": score,
        "confirmation_price": None if confirmation_price is None else round(confirmation_price, 4),
        "watch_zone": {
            "low": None if watch_low is None else round(watch_low, 4),
            "high": None if watch_high is None else round(watch_high, 4),
        },
        "distance_to_confirmation_pct": None if distance is None else round(distance, 2),
        "caution_reason": caution,
        "reader_note": reader_note(pattern_name, status or status_from_score(score, distance), distance),
    }


def reader_note(pattern_name: str, status: str, distance: float | None) -> str:
    if status == "gần xác nhận":
        return f"{pattern_name} đang ở gần vùng cần xác nhận; vẫn cần chờ giá đóng cửa vượt mốc quan sát."
    if status == "đang hình thành":
        return f"{pattern_name} có cấu trúc đáng quan sát nhưng chưa đủ điều kiện xác nhận."
    if status == "nhiễu":
        return f"{pattern_name} có vài nét giống mẫu nhưng đường giá còn nhiễu."
    suffix = f", còn cách vùng xác nhận khoảng {distance:.2f}%" if distance is not None else ""
    return f"{pattern_name} chưa đủ sạch để đọc mạnh{suffix}."


def detect_bull_flag(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    current = rows[-1]["close"]
    recent = rows[-14:]
    pole = rows[-44:-14]
    if len(pole) < 20:
        return None
    pole_move = pct(max(row["close"] for row in pole[-5:]), min(row["close"] for row in pole[:15]))
    recent_high = max(row["high"] for row in recent)
    recent_low = min(row["low"] for row in recent)
    recent_range = pct(recent_high, recent_low)
    pullback = pct(recent_high, current)
    compact = max(0, 25 - recent_range) * 2.2
    score = 30 + min(pole_move, 35) + compact - max(0, pullback - 8) * 2
    if pole_move < 10 or recent_range > 16:
        score -= 20
    return setup("bull_flags", "Cờ tăng", score, recent_high, recent_low, recent_high, current, "Cần có nhịp dẫn trước rõ và phần nghỉ không quá rộng.")


def detect_bull_pennant(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    current = rows[-1]["close"]
    recent = rows[-12:]
    prior = rows[-42:-12]
    if len(prior) < 20:
        return None
    prior_move = pct(max(row["close"] for row in prior[-5:]), min(row["close"] for row in prior[:15]))
    first_range = max(row["high"] for row in recent[:6]) - min(row["low"] for row in recent[:6])
    last_range = max(row["high"] for row in recent[-6:]) - min(row["low"] for row in recent[-6:])
    compression = 1 - (last_range / first_range) if first_range > 0 else 0
    recent_high = max(row["high"] for row in recent)
    recent_low = min(row["low"] for row in recent)
    score = 35 + min(prior_move, 30) + clamp(compression * 55, 0, 35) - max(0, pct(recent_high, recent_low) - 14) * 2
    if prior_move < 10:
        score -= 18
    return setup("bull_pennants", "Cờ đuôi nheo tăng", score, recent_high, recent_low, recent_high, current, "Cần thấy biên dao động co lại thay vì chỉ đi ngang rộng.")


def detect_ascending_triangle(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    current = rows[-1]["close"]
    window = rows[-45:]
    highs = [row["high"] for row in window]
    lows = [row["low"] for row in window]
    resistance = sorted(highs)[int(len(highs) * 0.8)]
    high_spread = pct(max(highs[-25:]), min(highs[-25:]))
    low_rise = pct(min(lows[-10:]), min(lows[:15]))
    distance = max(0.0, pct(resistance, current))
    score = 45 + min(max(low_rise, 0), 18) * 1.8 + max(0, 8 - high_spread) * 3 - distance * 1.5
    return setup("triangles_ascending", "Tam giác tăng", score, resistance, min(lows[-20:]), resistance, current, "Cần kháng cự đủ phẳng và đáy sau cao hơn đáy trước.")


def detect_falling_wedge(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    current = rows[-1]["close"]
    window = rows[-40:]
    highs = [row["high"] for row in window]
    lows = [row["low"] for row in window]
    high_slope = slope(highs)
    low_slope = slope(lows)
    width_start = max(highs[:10]) - min(lows[:10])
    width_end = max(highs[-10:]) - min(lows[-10:])
    narrows = 1 - width_end / width_start if width_start > 0 else 0
    upper_now = highs[0] + high_slope * (len(highs) - 1)
    distance = max(0.0, pct(upper_now, current)) if upper_now > 0 else None
    score = 40 + clamp(narrows * 60, 0, 35) + (12 if high_slope < 0 and low_slope < 0 else -15) - (distance or 0) * 1.2
    return setup("wedges_falling", "Nêm giảm", score, upper_now, min(lows[-15:]), upper_now, current, "Cần hai biên cùng dốc xuống và độ rộng thu hẹp.")


def detect_cup_with_handle(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if len(rows) < 75:
        return None
    current = rows[-1]["close"]
    window = rows[-90:]
    closes = [row["close"] for row in window]
    left_high = max(closes[:30])
    cup_low = min(closes[20:70])
    right_high = max(closes[55:])
    depth = pct(left_high, cup_low)
    recovery = pct(right_high, cup_low)
    handle = rows[-15:]
    handle_pullback = pct(max(row["high"] for row in handle), min(row["low"] for row in handle))
    confirmation = max(left_high, right_high)
    score = 35 + min(recovery, 35) + max(0, 35 - abs(depth - 25)) - max(0, handle_pullback - 16) * 2
    if depth < 12 or depth > 50:
        score -= 18
    return setup("cup_with_handle", "Cốc tay cầm", score, confirmation, min(row["low"] for row in handle), confirmation, current, "Mẫu dài, dễ nhiễu nếu tay cầm quá sâu hoặc hồi chưa đủ.")


def detect_rectangle_bottom(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    current = rows[-1]["close"]
    window = rows[-35:]
    prior = rows[-75:-35]
    high = max(row["high"] for row in window)
    low = min(row["low"] for row in window)
    range_pct = pct(high, low)
    prior_drop = pct(prior[0]["close"], min(row["close"] for row in prior)) if prior else 0
    distance = max(0.0, pct(high, current))
    score = 42 + max(0, 18 - abs(range_pct - 12)) * 2 + min(max(prior_drop, 0), 18) - distance
    return setup("rectangle_bottoms", "Chữ nhật đáy", score, high, low, high, current, "Cần vùng đi ngang đủ rõ sau một nhịp giảm hoặc tích lũy.")


def detect_double_bottom(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    current = rows[-1]["close"]
    window = rows[-65:]
    lows = [row["low"] for row in window]
    first_i = min(range(0, 32), key=lambda idx: lows[idx])
    second_i = min(range(32, len(lows)), key=lambda idx: lows[idx])
    first_low = lows[first_i]
    second_low = lows[second_i]
    low_gap = abs(pct(second_low, first_low))
    neckline = max(row["high"] for row in window[first_i:second_i + 1])
    distance = max(0.0, pct(neckline, current))
    separation = second_i - first_i
    score = 48 + max(0, 8 - low_gap) * 4 + min(separation, 30) * 0.5 - distance * 1.5
    if separation < 12:
        score -= 15
    return setup("double_bottoms", "Hai đáy", score, neckline, min(first_low, second_low), neckline, current, "Hai đáy cần tách nhau đủ xa và không lệch quá mạnh.")


def detect_measured_move_up(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    current = rows[-1]["close"]
    first = rows[-70:-35]
    pullback = rows[-35:-12]
    recent = rows[-12:]
    if not first or not pullback:
        return None
    leg_low = min(row["low"] for row in first)
    leg_high = max(row["high"] for row in first)
    leg_move = pct(leg_high, leg_low)
    pull_low = min(row["low"] for row in pullback)
    retrace = (leg_high - pull_low) / (leg_high - leg_low) * 100 if leg_high > leg_low else 100
    confirmation = max(row["high"] for row in recent)
    score = 38 + min(leg_move, 30) + max(0, 30 - abs(retrace - 50)) - max(0, pct(confirmation, current)) * 1.2
    if leg_move < 12 or retrace < 25 or retrace > 75:
        score -= 18
    return setup("measured_move_up", "Measured Move tăng", score, confirmation, pull_low, confirmation, current, "Cần nhịp đầu rõ, pha điều chỉnh vừa phải và chưa bị rơi vào vùng răng cưa.")


DETECTORS = [
    detect_bull_flag,
    detect_bull_pennant,
    detect_ascending_triangle,
    detect_falling_wedge,
    detect_cup_with_handle,
    detect_rectangle_bottom,
    detect_double_bottom,
    detect_measured_move_up,
]


def scan_symbol(symbol: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    latest = rows[-1]
    candidates = [candidate for detector in DETECTORS if (candidate := detector(rows))]
    candidates.sort(key=lambda row: (-float(row["completion_score"]), float(row.get("distance_to_confirmation_pct") or 999), row["pattern_name"]))
    headline = candidates[0] if candidates else None
    if headline:
        status = headline["setup_status"]
        plain = f"{symbol} có {headline['pattern_name']} ở trạng thái {status}; cần chờ xác nhận thay vì đọc như tín hiệu."
    else:
        status = "không có setup rõ"
        plain = "Hiện chưa có cấu trúc theo dõi chiều tăng đủ rõ trong các bộ quét nhẹ."
    return {
        "summary": {
            "symbol": symbol,
            "latest_date": str(latest.get("date"))[:10],
            "latest_close": round(float(latest["close"]), 4),
            "status_label": status,
            "plain_summary": plain,
            "setup_count": len(candidates),
        },
        "setups": candidates[:6],
    }


def build_payload(series: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    profiles = {symbol: scan_symbol(symbol, rows) for symbol, rows in sorted(series.items())}
    return {
        "metadata": {
            "workflow_id": "current_pattern_setups_v1",
            "generated_at": run_generated_at(),
            "symbol_count": len(profiles),
            "scanner_scope": "latest_series_lightweight_upside_setups",
            "non_advice_boundary": "Setup đang hình thành chỉ là cấu trúc cần quan sát, không phải tín hiệu mua bán.",
        },
        "profiles": profiles,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build current lightweight pattern setup JSON.")
    parser.add_argument("--stock-series-dir", default=str(DEFAULT_STOCK_SERIES_DIR))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()
    series = load_series(Path(args.stock_series_dir).expanduser())
    payload = build_payload(series)
    out = Path(args.out).expanduser()
    if not out.is_absolute():
        out = (ROOT / out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "out": str(out), "symbol_count": payload["metadata"]["symbol_count"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
