#!/usr/bin/env python3
"""Build per-stock chart-pattern history profiles for Market Stats.

This is a read-only aggregation layer. It reads existing pattern event
artifacts from the chart-pattern research project and exports a compact JSON
payload for the local Market Stats UI. It does not run scanners and it does not
make trading recommendations.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "market_stats" / "web" / "stock_pattern_profiles.json"
DEFAULT_STOCK_SERIES_DIR = ROOT / "market_stats" / "web" / "stock_series"
SAMPLE_THIN_N = 5
CURRENT_WINDOWS = (20, 60, 120)


def run_generated_at() -> str:
    """UTC ISO timestamp (seconds) shared across all artifacts of one pipeline
    run. The orchestrator (generate_simple_stats.main) sets
    MARKET_STATS_RUN_AT once and passes it via env so every build_* subprocess
    stamps the same value. Falls back to now-UTC when run standalone."""
    env_value = os.getenv("MARKET_STATS_RUN_AT", "").strip()
    if env_value:
        return env_value
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

PATTERN_LABELS = {
    "bull_flags": "Cờ tăng",
    "bear_flags": "Cờ giảm",
    "bull_pennants": "Cờ đuôi nheo tăng",
    "bear_pennants": "Cờ đuôi nheo giảm",
    "high_tight_flags": "Cờ cao và chặt",
    "triangles_ascending": "Tam giác tăng",
    "triangles_descending": "Tam giác giảm",
    "triangles_symmetrical": "Tam giác cân",
    "wedges_falling": "Nêm giảm",
    "wedges_rising": "Nêm tăng",
    "cup_with_handle": "Cốc tay cầm",
    "cup_with_handle_inverted": "Cốc tay cầm ngược",
    "rectangle_bottoms": "Chữ nhật đáy",
    "rectangle_tops": "Chữ nhật đỉnh",
    "head_and_shoulders_bottoms": "Vai đầu vai đáy",
    "head_and_shoulders_bottoms_complex": "Vai đầu vai đáy phức hợp",
    "head_and_shoulders_tops": "Vai đầu vai đỉnh",
    "head_and_shoulders_tops_complex": "Vai đầu vai đỉnh phức hợp",
    "broadening_bottoms": "Mở rộng đáy",
    "broadening_tops": "Mở rộng đỉnh",
    "broadening_formations_right_angled_ascending": "Mở rộng góc phải tăng",
    "broadening_formations_right_angled_descending": "Mở rộng góc phải giảm",
    "broadening_wedges_ascending": "Nêm mở rộng tăng",
    "broadening_wedges_descending": "Nêm mở rộng giảm",
    "measured_move_up": "Measured Move tăng",
    "measured_move_down": "Measured Move giảm",
    "scallops_ascending": "Scallop tăng",
    "scallops_descending": "Scallop giảm",
    "scallops_ascending_inverted": "Scallop tăng đảo",
    "scallops_descending_inverted": "Scallop giảm đảo",
    "pipe_bottoms": "Pipe Bottoms",
    "pipe_tops": "Pipe Tops",
    "horn_bottoms": "Horn Bottoms",
    "horn_tops": "Horn Tops",
    "diamond_bottoms": "Diamond Bottoms",
    "diamond_tops": "Diamond Tops",
    "dead_cat_bounce": "Dead-Cat Bounce",
    "dead_cat_bounce_inverted": "Dead-Cat Bounce ngược",
    "three_rising_valleys": "Ba đáy cao dần",
    "three_falling_peaks": "Ba đỉnh thấp dần",
    "triple_bottoms": "Ba đáy",
    "triple_tops": "Ba đỉnh",
    "bump_and_run_reversal_bottoms": "Bump-and-Run đáy",
    "bump_and_run_reversal_tops": "Bump-and-Run đỉnh",
    "rounding_bottoms": "Đáy tròn",
    "rounding_tops": "Đỉnh tròn",
    "inside_day": "Inside Day",
    "rising_three_methods": "Rising Three Methods",
    "falling_three_methods": "Falling Three Methods",
    "area_gaps": "Khoảng trống vùng",
    "breakaway_gaps": "Khoảng trống phá vỡ",
    "continuation_gaps": "Khoảng trống tiếp diễn",
    "exhaustion_gaps": "Khoảng trống kiệt sức",
    "island_reversals": "Đảo chiều đảo giá",
    "islands_long": "Đảo giá dài",
    "double_bottoms_adam_adam": "Hai đáy Adam-Adam",
    "double_bottoms_adam_eve": "Hai đáy Adam-Eve",
    "double_bottoms_eve_adam": "Hai đáy Eve-Adam",
    "double_bottoms_eve_eve": "Hai đáy Eve-Eve",
    "double_tops_adam_adam": "Hai đỉnh Adam-Adam",
    "double_tops_adam_eve": "Hai đỉnh Adam-Eve",
    "double_tops_eve_adam": "Hai đỉnh Eve-Adam",
    "double_tops_eve_eve": "Hai đỉnh Eve-Eve",
}


@dataclass(frozen=True)
class EventSource:
    pattern_id: str
    path: Path
    filters: Mapping[str, str]


def _discover_research_dir(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    candidates = [p for p in ROOT.iterdir() if p.is_dir() and "mô hình" in p.name]
    if candidates:
        return candidates[0].resolve()
    return (ROOT / "Nghiên cứu mô hình nến").resolve()


def _load_event_sources(research_dir: Path) -> list[EventSource]:
    if str(research_dir) not in sys.path:
        sys.path.insert(0, str(research_dir))
    try:
        from scanner.rebuild_source_guided_final_chapters import EVENT_SOURCES, DOUBLE_VARIANTS  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"Cannot import canonical event source map from {research_dir}: {exc}") from exc

    sources: list[EventSource] = []
    for pattern_id, (relative_path, filters) in EVENT_SOURCES.items():
        sources.append(EventSource(str(pattern_id), research_dir / Path(relative_path), dict(filters or {})))
    for pattern_id, (family, variant) in DOUBLE_VARIANTS.items():
        path = research_dir / "artifacts" / "scanner_v2" / "double_pattern_family_adam_eve" / family / "db_active" / "events.csv"
        sources.append(EventSource(str(pattern_id), path, {"variant": str(variant)}))
    return sources


def _to_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "hit", "pass"}:
        return True
    if text in {"0", "false", "no", "n", "nan", ""}:
        return False
    return None


def _finite(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(out):
        return None
    return out


def _first_value(row: Mapping[str, Any], names: list[str]) -> Any:
    for name in names:
        if name in row and pd.notna(row[name]):
            return row[name]
    return None


def _normalize_event(row: Mapping[str, Any], source: EventSource) -> dict[str, Any] | None:
    symbol = str(_first_value(row, ["symbol", "ticker"]) or "").strip().upper()
    if not symbol:
        return None
    date_value = _first_value(row, ["breakout_date", "confirmation_date", "event_date", "formation_end_date", "end_date"])
    breakout_date = str(date_value)[:10] if date_value is not None else ""
    mfe = _finite(_first_value(row, ["mfe_pct", "fav_exc", "favorable_excursion_pct", "post_flag_trend_move_pct"]))
    mae = _finite(_first_value(row, ["mae_pct", "adv_exc", "adverse_excursion_pct"]))
    if mfe is not None and abs(mfe) <= 1.5 and "mfe_pct" not in row:
        mfe *= 100
    if mae is not None and abs(mae) <= 1.5 and "mae_pct" not in row:
        mae *= 100
    target_hit = _to_bool(_first_value(row, ["target_hit", "hit_target", "target_reached"]))
    failure_5 = _to_bool(_first_value(row, ["failure_5pct", "failure_5", "stop_hit_5pct"]))
    direction = str(_first_value(row, ["breakout_direction", "direction"]) or "").strip().lower()
    market_group = str(_first_value(row, ["market_group"]) or "").strip()
    breakout_price = _finite(_first_value(row, ["breakout_price", "b_exec_price"]))
    target_price = _finite(_first_value(row, ["target_price"]))
    return {
        "event_id": str(_first_value(row, ["detection_id", "event_id"]) or f"{source.pattern_id}:{symbol}:{breakout_date}"),
        "symbol": symbol,
        "pattern_id": source.pattern_id,
        "pattern_name": PATTERN_LABELS.get(source.pattern_id, source.pattern_id.replace("_", " ")),
        "breakout_date": breakout_date,
        "direction": direction,
        "breakout_price": breakout_price,
        "target_price": target_price,
        "target_hit": target_hit,
        "failure_5": failure_5,
        "mfe": mfe,
        "mae": abs(mae) if mae is not None else None,
        "market_group": market_group,
        "source_artifact": str(source.path),
    }


def load_events(research_dir: Path) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    source_reports: list[dict[str, Any]] = []
    for source in _load_event_sources(research_dir):
        if not source.path.is_file():
            source_reports.append({"pattern_id": source.pattern_id, "path": str(source.path), "status": "missing"})
            continue
        try:
            df = pd.read_csv(source.path, low_memory=False)
        except Exception as exc:
            source_reports.append({"pattern_id": source.pattern_id, "path": str(source.path), "status": "read_error", "error": str(exc)})
            continue
        for key, value in source.filters.items():
            if key in df.columns:
                df = df.loc[df[key].astype(str).str.lower().eq(str(value).lower())].copy()
        normalized = 0
        for record in df.to_dict("records"):
            event = _normalize_event(record, source)
            if event:
                rows.append(event)
                normalized += 1
        source_reports.append({"pattern_id": source.pattern_id, "path": str(source.path), "status": "ok", "rows": normalized})
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    out["_date"] = pd.to_datetime(out["breakout_date"], errors="coerce")
    out = out.sort_values(["symbol", "_date", "pattern_id"], na_position="last").drop_duplicates(["event_id", "pattern_id"])
    out.attrs["source_reports"] = source_reports
    return out


def _pct_bool(series: pd.Series) -> float | None:
    values = series.dropna().map(bool)
    if values.empty:
        return None
    return round(float(values.mean() * 100), 2)


def _median_or_none(series: pd.Series) -> float | None:
    values = pd.to_numeric(series, errors="coerce").dropna()
    if values.empty:
        return None
    return _finite(values.median())


def _sample_label(n: int) -> str:
    if n < 2:
        return "rất mỏng"
    if n < SAMPLE_THIN_N:
        return "mẫu mỏng"
    if n < 10:
        return "đủ tham khảo"
    return "khá dày"


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _direction_sign(event: Mapping[str, Any]) -> int:
    direction = str(event.get("direction") or "").lower()
    if direction in {"down", "bear", "short"}:
        return -1
    if direction in {"up", "bull", "long"}:
        return 1
    breakout = _finite(event.get("breakout_price"))
    target = _finite(event.get("target_price"))
    if breakout and target and target < breakout:
        return -1
    return 1


def _load_current_prices(stock_series_dir: Path) -> dict[str, dict[str, Any]]:
    prices: dict[str, dict[str, Any]] = {}
    if not stock_series_dir.is_dir():
        return prices
    for path in stock_series_dir.glob("*.json"):
        symbol = path.stem.upper()
        if " " in symbol:
            continue
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        clean_rows = [
            row for row in rows
            if isinstance(row, dict) and row.get("date") and _finite(row.get("close")) is not None
        ]
        if not clean_rows:
            continue
        clean_rows.sort(key=lambda row: str(row.get("date")))
        latest = clean_rows[-1]
        prices[symbol] = {
            "date": str(latest.get("date"))[:10],
            "close": _finite(latest.get("close")),
            "dates": [str(row.get("date"))[:10] for row in clean_rows],
        }
    return prices


def _bars_since(dates: list[str], event_date: str) -> int | None:
    if not dates or not event_date:
        return None
    return sum(1 for item in dates if item > event_date)


def _current_status(event: Mapping[str, Any], days_since: int | None) -> str:
    if event.get("target_hit") is True:
        return "đã đạt mục tiêu"
    if event.get("failure_5") is True:
        return "đã thất bại"
    if days_since is None:
        return "đang theo dõi"
    if days_since <= 20:
        return "vừa xác nhận"
    if days_since <= 60:
        return "đang theo dõi"
    return "quá hạn"


def _current_pattern_event(row: Mapping[str, Any], current: Mapping[str, Any]) -> dict[str, Any]:
    breakout_price = _finite(row.get("breakout_price"))
    target_price = _finite(row.get("target_price"))
    current_close = _finite(current.get("close"))
    event_date = str(row.get("breakout_date") or row.get("_date") or "")[:10]
    days_since = _bars_since(list(current.get("dates") or []), event_date)
    sign = _direction_sign(row)
    current_move = None
    target_gap = None
    if breakout_price and current_close:
        current_move = sign * (current_close / breakout_price - 1) * 100
    if target_price and current_close:
        target_gap = sign * (target_price - current_close) / current_close * 100
    status = _current_status(row, days_since)
    if target_gap is not None and target_gap <= 0 and status not in {"đã thất bại"}:
        status = "đã đạt mục tiêu"
    return {
        "date": event_date,
        "pattern_id": row.get("pattern_id"),
        "pattern_name": row.get("pattern_name"),
        "direction": row.get("direction") or "",
        "days_since": days_since,
        "breakout_price": None if breakout_price is None else round(breakout_price, 4),
        "target_price": None if target_price is None else round(target_price, 4),
        "current_price": None if current_close is None else round(current_close, 4),
        "current_date": current.get("date"),
        "current_move_pct": None if current_move is None else round(current_move, 2),
        "target_gap_pct": None if target_gap is None else round(target_gap, 2),
        "target_hit": row.get("target_hit"),
        "failure_5": row.get("failure_5"),
        "status_label": status,
        "reader_note": _current_reader_note(status, row.get("pattern_name"), days_since),
    }


def _current_reader_note(status: str, pattern_name: Any, days_since: int | None) -> str:
    name = str(pattern_name or "mẫu hình")
    if status == "vừa xác nhận":
        return f"{name} mới được xác nhận gần đây; chỉ đọc như điểm cần theo dõi thêm."
    if status == "đang theo dõi":
        suffix = f" sau {days_since} phiên" if days_since is not None else ""
        return f"{name} vẫn còn trong cửa sổ quan sát{suffix}."
    if status == "đã đạt mục tiêu":
        return f"{name} đã đi đủ xa so với mốc mục tiêu được ghi nhận."
    if status == "đã thất bại":
        return f"{name} từng đi ngược đáng kể, nên đọc thận trọng."
    return f"{name} đã qua cửa sổ theo dõi ngắn hạn."


def _current_patterns(symbol_df: pd.DataFrame, current: Mapping[str, Any] | None) -> dict[str, Any]:
    if not current:
        return {"status_label": "không có dữ liệu giá hiện tại", "items": [], "windows": {}}
    rows = []
    for row in symbol_df.sort_values("_date", ascending=False).to_dict("records"):
        event = _current_pattern_event(row, current)
        days_since = event.get("days_since")
        if days_since is not None and days_since <= max(CURRENT_WINDOWS):
            rows.append(event)
    windows = {
        str(window): sum(1 for row in rows if row.get("days_since") is not None and int(row["days_since"]) <= window)
        for window in CURRENT_WINDOWS
    }
    if not rows:
        return {
            "status_label": "không có mẫu hình hiện tại",
            "plain_summary": "Hiện chưa có mẫu hình mới đủ điều kiện trong cửa sổ theo dõi.",
            "items": [],
            "windows": windows,
        }
    headline = rows[0]
    return {
        "status_label": headline["status_label"],
        "plain_summary": (
            f"Mẫu mới nhất là {headline['pattern_name']} ngày {headline['date']}; "
            f"trạng thái hiện tại: {headline['status_label']}."
        ),
        "items": rows[:8],
        "windows": windows,
    }


def _freshness_score(last_date: pd.Timestamp | None, max_date: pd.Timestamp | None) -> float:
    if last_date is None or pd.isna(last_date) or max_date is None or pd.isna(max_date):
        return 30.0
    days = max(0, int((max_date - last_date).days))
    if days <= 365:
        return 100.0
    if days <= 365 * 3:
        return 70.0
    if days <= 365 * 5:
        return 50.0
    return 30.0


def _pattern_profile(group: pd.DataFrame, max_date: pd.Timestamp | None) -> dict[str, Any]:
    n = int(len(group))
    median_mfe = _median_or_none(group["mfe"]) if "mfe" in group else None
    median_mae = _median_or_none(group["mae"]) if "mae" in group else None
    hit_rate = _pct_bool(group["target_hit"]) if "target_hit" in group else None
    failure_rate = _pct_bool(group["failure_5"]) if "failure_5" in group else None
    last_date = group["_date"].max() if "_date" in group else None
    freq_score = _clamp(n / 10 * 100)
    edge = (median_mfe or 0) - (median_mae or 0)
    outcome_score = _clamp(50 + edge * 2)
    clean_path_score = _clamp(100 - (failure_rate or 0) * 0.7 - max(0.0, (median_mae or 0) - 10) * 2)
    fresh_score = _freshness_score(last_date, max_date)
    score = 0.25 * freq_score + 0.35 * outcome_score + 0.25 * clean_path_score + 0.15 * fresh_score
    if n < SAMPLE_THIN_N:
        score -= (SAMPLE_THIN_N - n) * 4
    score = round(_clamp(score), 2)
    status = "trung tính"
    if n < SAMPLE_THIN_N:
        status = "mẫu mỏng"
    elif score >= 70 and edge > 0 and (failure_rate is None or failure_rate < 45):
        status = "mạnh hơn lịch sử của chính mã"
    elif failure_rate is not None and failure_rate >= 55:
        status = "cần thận trọng"
    elif median_mae is not None and median_mfe is not None and median_mae > median_mfe:
        status = "cần thận trọng"
    return {
        "pattern_id": str(group["pattern_id"].iloc[0]),
        "pattern_name": str(group["pattern_name"].iloc[0]),
        "n": n,
        "sample_label": _sample_label(n),
        "status_label": status,
        "last_seen": None if pd.isna(last_date) else str(last_date.date()),
        "median_mfe_pct": None if median_mfe is None else round(median_mfe, 2),
        "median_mae_pct": None if median_mae is None else round(median_mae, 2),
        "target_hit_rate_pct": hit_rate,
        "failure_5_rate_pct": failure_rate,
        "frequency_score": round(freq_score, 2),
        "outcome_score": round(outcome_score, 2),
        "clean_path_score": round(clean_path_score, 2),
        "freshness_score": round(fresh_score, 2),
        "stock_pattern_score": score,
    }


def build_profiles(events: pd.DataFrame, current_prices: Mapping[str, Mapping[str, Any]] | None = None) -> dict[str, Any]:
    if events.empty:
        return {
            "metadata": {
                "workflow_id": "stock_pattern_profiles_v1",
                "generated_at": run_generated_at(),
                "event_count": 0,
                "symbol_count": 0,
            },
            "profiles": {},
        }
    max_date = events["_date"].max()
    profiles: dict[str, Any] = {}
    for symbol, symbol_df in events.groupby("symbol", sort=True):
        patterns = [
            _pattern_profile(pattern_df, max_date)
            for _, pattern_df in symbol_df.groupby("pattern_id", sort=True)
        ]
        patterns.sort(key=lambda row: (-int(row["n"]), str(row["pattern_name"])))
        best = sorted(patterns, key=lambda row: (-float(row["stock_pattern_score"]), -int(row["n"]), str(row["pattern_name"])))
        caution = [
            row for row in sorted(patterns, key=lambda row: (-float(row["failure_5_rate_pct"] or 0), -float(row["median_mae_pct"] or 0)))
            if row["status_label"] == "cần thận trọng" or int(row["n"]) < 2
        ]
        recent = symbol_df.sort_values("_date", ascending=False).head(12)
        total = int(len(symbol_df))
        profiles[str(symbol)] = {
            "summary": {
                "symbol": str(symbol),
                "total_events": total,
                "distinct_patterns": int(symbol_df["pattern_id"].nunique()),
                "last_event_date": str(symbol_df["_date"].max().date()) if pd.notna(symbol_df["_date"].max()) else None,
                "sample_label": _sample_label(total),
                "sample_warning": total < SAMPLE_THIN_N,
                "plain_summary": _plain_summary(str(symbol), patterns, best, total),
            },
            "most_common_patterns": patterns[:8],
            "best_historical_patterns": best[:8],
            "caution_patterns": caution[:8],
            "current_patterns": _current_patterns(symbol_df, (current_prices or {}).get(str(symbol))),
            "recent_events": [
                {
                    "date": str(row["_date"].date()) if pd.notna(row["_date"]) else row.get("breakout_date"),
                    "pattern_id": row.get("pattern_id"),
                    "pattern_name": row.get("pattern_name"),
                    "direction": row.get("direction") or "",
                    "outcome_label": _event_outcome_label(row),
                    "mfe_pct": None if pd.isna(row.get("mfe")) else round(float(row.get("mfe")), 2),
                    "mae_pct": None if pd.isna(row.get("mae")) else round(float(row.get("mae")), 2),
                }
                for row in recent.to_dict("records")
            ],
        }
    return {
        "metadata": {
            "workflow_id": "stock_pattern_profiles_v1",
            "generated_at": run_generated_at(),
            "event_count": int(len(events)),
            "symbol_count": int(events["symbol"].nunique()),
            "pattern_count": int(events["pattern_id"].nunique()),
            "sample_thin_n": SAMPLE_THIN_N,
            "non_advice_boundary": "Hồ sơ hành vi lịch sử theo mẫu hình giá; không phải tín hiệu mua bán.",
        },
        "profiles": profiles,
    }


def _plain_summary(symbol: str, patterns: list[dict[str, Any]], best: list[dict[str, Any]], total: int) -> str:
    if total == 0 or not patterns:
        return f"{symbol} chưa có đủ sự kiện mẫu hình trong kho dữ liệu hiện tại."
    common = patterns[0]
    if total < SAMPLE_THIN_N:
        return f"{symbol} mới có {total} sự kiện mẫu hình, nên chỉ nên đọc như ghi chú tham khảo."
    best_row = best[0]
    return (
        f"{symbol} xuất hiện nhiều nhất ở nhóm {common['pattern_name']}; "
        f"nhóm có hồ sơ lịch sử thuận lợi hơn hiện là {best_row['pattern_name']}."
    )


def _event_outcome_label(row: Mapping[str, Any]) -> str:
    if row.get("target_hit") is True:
        return "đã đạt mục tiêu"
    if row.get("failure_5") is True:
        return "từng đi ngược đáng kể"
    return "tham khảo/đang theo dõi"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Market Stats stock-pattern profile JSON.")
    parser.add_argument("--research-dir", default="")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--stock-series-dir", default=str(DEFAULT_STOCK_SERIES_DIR))
    args = parser.parse_args()

    research_dir = _discover_research_dir(args.research_dir or None)
    events = load_events(research_dir)
    current_prices = _load_current_prices(Path(args.stock_series_dir).expanduser())
    payload = build_profiles(events, current_prices)
    payload["metadata"]["research_dir"] = str(research_dir)
    payload["metadata"]["source_reports"] = events.attrs.get("source_reports", []) if hasattr(events, "attrs") else []
    out = Path(args.out).expanduser()
    if not out.is_absolute():
        out = (ROOT / out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "out": str(out), "event_count": payload["metadata"]["event_count"], "symbol_count": payload["metadata"]["symbol_count"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
