#!/usr/bin/env python3
"""Build per-stock pattern personality profiles for Market Stats.

This is an aggregation layer over existing artifacts. It does not run the
historical scanners and it does not create trading recommendations.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import pandas as pd

from build_stock_pattern_profiles import _discover_research_dir, load_events


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PATTERN_PROFILE = ROOT / "market_stats" / "web" / "stock_pattern_profiles.json"
DEFAULT_CURRENT_SETUPS = ROOT / "market_stats" / "web" / "current_pattern_setups.json"
DEFAULT_OUT = ROOT / "market_stats" / "web" / "stock_pattern_personality_profiles.json"
SAMPLE_THIN_N = 5


def run_generated_at() -> str:
    """UTC ISO timestamp (seconds) shared across all artifacts of one pipeline
    run. See generate_simple_stats.run_generated_at."""
    env_value = os.getenv("MARKET_STATS_RUN_AT", "").strip()
    if env_value:
        return env_value
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

CONTINUATION_PATTERNS = {
    "bull_flags",
    "bull_pennants",
    "high_tight_flags",
    "measured_move_up",
    "continuation_gaps",
    "rising_three_methods",
}
ACCUMULATION_PATTERNS = {
    "triangles_ascending",
    "triangles_symmetrical",
    "rectangle_bottoms",
    "cup_with_handle",
    "double_bottoms_adam_adam",
    "double_bottoms_adam_eve",
    "double_bottoms_eve_adam",
    "double_bottoms_eve_eve",
    "triple_bottoms",
    "pipe_bottoms",
    "rounding_bottoms",
}
DOWNSIDE_PATTERNS = {
    "bear_flags",
    "bear_pennants",
    "triangles_descending",
    "rectangle_tops",
    "head_and_shoulders_tops",
    "head_and_shoulders_tops_complex",
    "measured_move_down",
    "pipe_tops",
    "horn_tops",
    "diamond_tops",
    "three_falling_peaks",
    "triple_tops",
    "bump_and_run_reversal_tops",
    "falling_three_methods",
    "cup_with_handle_inverted",
}


def finite(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def median(values: list[float]) -> float | None:
    clean = sorted(value for value in values if math.isfinite(value))
    if not clean:
        return None
    mid = len(clean) // 2
    if len(clean) % 2:
        return clean[mid]
    return (clean[mid - 1] + clean[mid]) / 2


def rate(values: list[Any]) -> float | None:
    clean = [bool(value) for value in values if value is not None and not (isinstance(value, float) and math.isnan(value))]
    if not clean:
        return None
    return sum(1 for value in clean if value) / len(clean) * 100


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"metadata": {}, "profiles": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def pattern_family(pattern_id: str) -> str:
    if pattern_id in CONTINUATION_PATTERNS:
        return "trend_following"
    if pattern_id in ACCUMULATION_PATTERNS:
        return "accumulation_breakout"
    if pattern_id in DOWNSIDE_PATTERNS:
        return "defensive_caution"
    if "bottom" in pattern_id or "valleys" in pattern_id:
        return "reversal_or_recovery"
    if "top" in pattern_id or "peaks" in pattern_id:
        return "defensive_caution"
    return "mixed"


def compact_pattern(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "pattern_id": row.get("pattern_id"),
        "pattern_name": row.get("pattern_name"),
        "n": row.get("n"),
        "status_label": row.get("status_label"),
        "sample_label": row.get("sample_label"),
        "median_mfe_pct": row.get("median_mfe_pct"),
        "median_mae_pct": row.get("median_mae_pct"),
        "target_hit_rate_pct": row.get("target_hit_rate_pct"),
        "failure_5_rate_pct": row.get("failure_5_rate_pct"),
        "stock_pattern_score": row.get("stock_pattern_score"),
    }


def pattern_profile_block(profile: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "summary": profile.get("summary", {}),
        "most_common_patterns": [compact_pattern(row) for row in profile.get("most_common_patterns", [])[:5]],
        "best_historical_patterns": [compact_pattern(row) for row in profile.get("best_historical_patterns", [])[:5]],
        "caution_patterns": [compact_pattern(row) for row in profile.get("caution_patterns", [])[:5]],
    }


def behavior_label(n: int, mfe: float | None, mae: float | None, failure: float | None) -> str:
    if n < SAMPLE_THIN_N:
        return "mẫu mỏng"
    if mfe is None or mae is None:
        return "chưa đủ dữ liệu đường đi"
    if failure is not None and failure >= 55:
        return "hay thất bại"
    if mae > mfe:
        return "hay kéo ngược"
    if mfe >= mae * 1.4 and (failure is None or failure < 35):
        return "đi tiếp khá sạch"
    return "nhiễu vừa phải"


def after_buy_behavior(symbol_events: pd.DataFrame) -> dict[str, Any]:
    if symbol_events.empty:
        return {
            "sample_label": "không có dữ liệu",
            "headline_label": "chưa đủ dữ liệu",
            "key_patterns": [],
            "reader_note": "Chưa đủ event để mô tả hành vi sau xác nhận.",
        }
    rows: list[dict[str, Any]] = []
    for pattern_id, group in symbol_events.groupby("pattern_id", sort=True):
        mfe = median([float(value) for value in pd.to_numeric(group["mfe"], errors="coerce").dropna()])
        mae = median([float(value) for value in pd.to_numeric(group["mae"], errors="coerce").dropna()])
        hit = rate(group["target_hit"].tolist())
        failure = rate(group["failure_5"].tolist())
        n = int(len(group))
        rows.append(
            {
                "pattern_id": str(pattern_id),
                "pattern_name": str(group["pattern_name"].iloc[0]),
                "family": pattern_family(str(pattern_id)),
                "n": n,
                "median_mfe_pct": None if mfe is None else round(mfe, 2),
                "median_mae_pct": None if mae is None else round(mae, 2),
                "target_hit_rate_pct": None if hit is None else round(hit, 2),
                "failure_5_rate_pct": None if failure is None else round(failure, 2),
                "behavior_label": behavior_label(n, mfe, mae, failure),
                "return_to_confirmation_note": "Chưa tách riêng nhịp quay lại vùng xác nhận trong dữ liệu hiện tại.",
            }
        )
    rows.sort(
        key=lambda row: (
            row["behavior_label"] != "đi tiếp khá sạch",
            -(row["n"] or 0),
            -float(row["median_mfe_pct"] or 0),
            str(row["pattern_name"]),
        )
    )
    headline = rows[0]
    return {
        "sample_label": "mẫu mỏng" if len(symbol_events) < SAMPLE_THIN_N else "đủ tham khảo",
        "headline_label": headline["behavior_label"],
        "key_patterns": rows[:6],
        "reader_note": (
            f"Sau xác nhận, nhóm nổi bật nhất của mã này là {headline['pattern_name']} "
            f"với nhãn đọc {headline['behavior_label']}."
        ),
    }


def failure_behavior(symbol_events: pd.DataFrame) -> dict[str, Any]:
    if symbol_events.empty:
        return {
            "main_failure_patterns": [],
            "failure_style": "chưa đủ dữ liệu",
            "reader_note": "Chưa đủ event để mô tả kiểu thất bại.",
        }
    rows: list[dict[str, Any]] = []
    for pattern_id, group in symbol_events.groupby("pattern_id", sort=True):
        failure = rate(group["failure_5"].tolist())
        mae = median([float(value) for value in pd.to_numeric(group["mae"], errors="coerce").dropna()])
        hit = rate(group["target_hit"].tolist())
        n = int(len(group))
        if n < 2 and (failure or 0) < 50:
            continue
        rows.append(
            {
                "pattern_id": str(pattern_id),
                "pattern_name": str(group["pattern_name"].iloc[0]),
                "n": n,
                "failure_5_rate_pct": None if failure is None else round(failure, 2),
                "median_mae_pct": None if mae is None else round(mae, 2),
                "target_hit_rate_pct": None if hit is None else round(hit, 2),
            }
        )
    rows.sort(key=lambda row: (-float(row["failure_5_rate_pct"] or 0), -float(row["median_mae_pct"] or 0), -int(row["n"] or 0)))
    headline = rows[0] if rows else None
    if not headline:
        style = "không có nhóm thất bại nổi bật"
        note = "Lịch sử hiện tại chưa cho thấy một kiểu thất bại nổi bật trên mã này."
    elif (headline["failure_5_rate_pct"] or 0) >= 55:
        style = "hay đi ngược sau xác nhận"
        note = f"{headline['pattern_name']} là nhóm cần đọc thận trọng hơn vì tỷ lệ đi ngược 5% cao trên chính mã này."
    elif (headline["median_mae_pct"] or 0) >= 15:
        style = "hay kéo ngược sâu"
        note = f"{headline['pattern_name']} từng có mức kéo ngược sâu, kể cả khi mẫu không nhất thiết thất bại hoàn toàn."
    else:
        style = "thất bại chưa có mẫu rõ"
        note = "Các thất bại phân tán giữa nhiều mẫu, chưa nên gán cho một mẫu riêng."
    return {
        "main_failure_patterns": rows[:5],
        "failure_style": style,
        "reader_note": note,
    }


def bear_trap_caution(symbol_events: pd.DataFrame) -> dict[str, Any]:
    if symbol_events.empty:
        return {
            "sample_label": "không có dữ liệu",
            "caution_label": "không rõ",
            "downside_event_count": 0,
            "reclaim_proxy_rate_pct": None,
            "reader_note": "Chưa đủ mẫu giảm để đánh giá rủi ro đọc sai nhịp phá xuống.",
        }
    downside = symbol_events[
        symbol_events["pattern_id"].astype(str).isin(DOWNSIDE_PATTERNS)
        | symbol_events["direction"].astype(str).str.lower().isin(["down", "bear", "short"])
    ].copy()
    n = int(len(downside))
    if n < 3:
        return {
            "sample_label": "ít dữ liệu",
            "caution_label": "không rõ",
            "downside_event_count": n,
            "reclaim_proxy_rate_pct": None,
            "reader_note": "Mã này có quá ít mẫu giảm để kết luận về bẫy giảm hoặc nhịp giảm tiếp diễn.",
        }
    reclaim_proxy = rate(downside["failure_5"].tolist())
    hit_rate = rate(downside["target_hit"].tolist())
    if reclaim_proxy is not None and reclaim_proxy >= 50:
        label = "có dấu hiệu bẫy giảm"
        note = "Nhiều mẫu giảm từng đi ngược lại ngưỡng thất bại 5%, nên đọc nhịp phá xuống thận trọng."
    elif hit_rate is not None and hit_rate >= 50:
        label = "mẫu giảm thường đi tiếp"
        note = "Các mẫu giảm trong lịch sử mã này thường đi đủ xa hơn, nên không nên xem nhẹ cảnh báo rủi ro."
    else:
        label = "không rõ"
        note = "Mẫu giảm chưa nghiêng rõ về trap hay tiếp diễn."
    return {
        "sample_label": "đủ tham khảo" if n >= SAMPLE_THIN_N else "ít dữ liệu",
        "caution_label": label,
        "downside_event_count": n,
        "reclaim_proxy_rate_pct": None if reclaim_proxy is None else round(reclaim_proxy, 2),
        "downside_target_hit_rate_pct": None if hit_rate is None else round(hit_rate, 2),
        "reader_note": note,
    }


def stock_archetype(profile: Mapping[str, Any], after_buy: Mapping[str, Any], failure: Mapping[str, Any], bear: Mapping[str, Any]) -> dict[str, Any]:
    summary = profile.get("summary", {})
    total = int(summary.get("total_events") or 0)
    labels: list[str] = []
    reasons: list[str] = []
    if total < SAMPLE_THIN_N:
        labels.append("thin_evidence")
        reasons.append("Cỡ mẫu lịch sử của mã còn mỏng.")
    patterns = profile.get("best_historical_patterns", []) + profile.get("most_common_patterns", [])
    family_counts: dict[str, int] = {}
    for row in patterns:
        family = pattern_family(str(row.get("pattern_id") or ""))
        family_counts[family] = family_counts.get(family, 0) + int(row.get("n") or 0)
    if family_counts.get("trend_following", 0) >= 8:
        labels.append("trend_following")
        reasons.append("Các mẫu tiếp diễn xuất hiện hoặc xếp hạng tốt trong lịch sử của mã.")
    if family_counts.get("accumulation_breakout", 0) >= 8:
        labels.append("accumulation_breakout")
        reasons.append("Các nền tích lũy như tam giác, chữ nhật, cốc tay cầm hoặc hai đáy có vai trò đáng kể.")
    if after_buy.get("headline_label") in {"hay kéo ngược", "nhiễu vừa phải"}:
        labels.append("mean_reverting")
        reasons.append("Đường đi sau xác nhận thường cần chấp nhận kéo ngược hoặc dao động.")
    if failure.get("failure_style") in {"hay đi ngược sau xác nhận", "hay kéo ngược sâu"} or bear.get("caution_label") == "có dấu hiệu bẫy giảm":
        labels.append("trap_prone")
        reasons.append("Lịch sử có dấu hiệu phá vỡ hoặc mẫu giảm dễ gây đọc sai.")
    if after_buy.get("headline_label") == "hay thất bại":
        labels.append("noisy")
        reasons.append("Một số mẫu có tỷ lệ đi ngược 5% cao, nên hạ độ tự tin khi đọc chart.")
    if not labels:
        labels.append("mixed")
        reasons.append("Mã có hồ sơ pha trộn, chưa nghiêng rõ về một kiểu hành vi.")
    primary = labels[0] if "thin_evidence" not in labels else "thin_evidence"
    if "trend_following" in labels:
        primary = "trend_following"
    elif "accumulation_breakout" in labels:
        primary = "accumulation_breakout"
    elif "trap_prone" in labels:
        primary = "trap_prone"
    return {
        "primary": primary,
        "labels": list(dict.fromkeys(labels)),
        "reasons": reasons[:5],
        "reader_note": archetype_note(primary),
    }


def archetype_note(label: str) -> str:
    notes = {
        "trend_following": "Mã này nên được đọc ưu tiên theo nhịp tiếp diễn và sức giữ xu hướng.",
        "accumulation_breakout": "Mã này nên được đọc kỹ ở các nền tích lũy và phiên xác nhận thoát nền.",
        "mean_reverting": "Mã này thường cần theo dõi phản ứng sau xác nhận vì đường đi có thể kéo ngược.",
        "trap_prone": "Mã này cần đặc biệt thận trọng với phá vỡ giả hoặc nhịp giảm bị kéo ngược.",
        "noisy": "Mã này có đường đi nhiễu, nên hạ kỳ vọng với mọi mẫu hình đơn lẻ.",
        "thin_evidence": "Cỡ mẫu còn mỏng, chỉ nên xem như ghi chú ban đầu.",
        "mixed": "Hồ sơ còn pha trộn, nên đọc theo từng mẫu cụ thể thay vì gắn một nhãn mạnh.",
    }
    return notes.get(label, notes["mixed"])


def archetype_label(label: str) -> str:
    labels = {
        "trend_following": "thiên về đi theo xu hướng",
        "accumulation_breakout": "thiên về nền tích lũy",
        "mean_reverting": "hay kéo ngược sau xác nhận",
        "trap_prone": "dễ có phá vỡ gây đọc sai",
        "noisy": "đường đi nhiễu",
        "thin_evidence": "mẫu còn mỏng",
        "mixed": "hồ sơ pha trộn",
    }
    return labels.get(label, labels["mixed"])


def plain_summary(symbol: str, profile: Mapping[str, Any], current: Mapping[str, Any], setup: Mapping[str, Any], after_buy: Mapping[str, Any], failure: Mapping[str, Any], archetype: Mapping[str, Any]) -> dict[str, str]:
    common = (profile.get("most_common_patterns") or [{}])[0]
    best = (profile.get("best_historical_patterns") or [{}])[0]
    caution = (profile.get("caution_patterns") or [{}])[0]
    current_summary = current.get("plain_summary") or "Hiện chưa có mẫu hình mới đủ điều kiện trong cửa sổ theo dõi."
    setup_summary = (setup.get("summary") or {}).get("plain_summary") or "Hiện chưa có cấu trúc theo dõi chiều tăng đủ rõ."
    overview = (
        f"{symbol} xuất hiện nhiều nhất ở nhóm {common.get('pattern_name', 'chưa rõ')}. "
        f"Nhóm từng có hồ sơ thuận lợi hơn là {best.get('pattern_name', 'chưa rõ')}, "
        f"trong khi nhóm cần đọc thận trọng hơn là {caution.get('pattern_name', 'chưa nổi bật')}."
    )
    behavior = (
        f"Sau xác nhận, nhãn hành vi chính hiện là {after_buy.get('headline_label', 'chưa đủ dữ liệu')}. "
        f"{failure.get('reader_note', '')}"
    ).strip()
    present = f"{current_summary} {setup_summary}".strip()
    primary_label = archetype_label(str(archetype.get("primary") or "mixed"))
    usage = (
        f"Nên đọc {symbol} như kiểu {primary_label}: "
        f"{archetype.get('reader_note', 'đọc theo từng mẫu cụ thể')} "
        "Đây là hồ sơ quan sát, không phải tín hiệu mua bán."
    )
    return {
        "overview": overview,
        "current_state": present,
        "behavior": behavior,
        "usage_note": usage,
    }


def build_payload(pattern_payload: Mapping[str, Any], setup_payload: Mapping[str, Any], events: pd.DataFrame) -> dict[str, Any]:
    pattern_profiles = pattern_payload.get("profiles", {})
    setup_profiles = setup_payload.get("profiles", {})
    profiles: dict[str, Any] = {}
    data_dates = [
        (setup_payload.get("metadata") or {}).get("generated_at"),
        (pattern_payload.get("metadata") or {}).get("generated_at"),
    ]
    # Pre-group events by symbol ONCE so the per-symbol lookup below is O(1)
    # instead of scanning the whole events column for each of the 1552 symbols
    # (the old events.loc[events["symbol"].eq(symbol)] was O(n_symbols * n_events)).
    events_by_symbol = {} if events.empty else {sym: grp.copy() for sym, grp in events.groupby("symbol")}
    for symbol in sorted(set(pattern_profiles) | set(setup_profiles)):
        pattern_profile = pattern_profiles.get(symbol, {})
        setup_profile = setup_profiles.get(symbol, {})
        symbol_events = events_by_symbol.get(symbol, pd.DataFrame())
        after = after_buy_behavior(symbol_events)
        failure = failure_behavior(symbol_events)
        bear = bear_trap_caution(symbol_events)
        archetype = stock_archetype(pattern_profile, after, failure, bear)
        current = pattern_profile.get("current_patterns", {})
        profiles[symbol] = {
            "symbol": symbol,
            "summary": {
                "symbol": symbol,
                "total_events": (pattern_profile.get("summary") or {}).get("total_events", 0),
                "distinct_patterns": (pattern_profile.get("summary") or {}).get("distinct_patterns", 0),
                "last_event_date": (pattern_profile.get("summary") or {}).get("last_event_date"),
                "setup_count": (setup_profile.get("summary") or {}).get("setup_count", 0),
                "personality_label": archetype["primary"],
            },
            "historical_pattern_profile": pattern_profile_block(pattern_profile),
            "current_confirmed_patterns": current,
            "current_forming_setups": setup_profile,
            "after_buy_behavior": after,
            "failure_behavior": failure,
            "bear_trap_caution": bear,
            "stock_archetype": archetype,
            "plain_vietnamese_summary": plain_summary(symbol, pattern_profile, current, setup_profile, after, failure, archetype),
        }
    return {
        "metadata": {
            "workflow_id": "stock_pattern_personality_profiles_v1",
            "version": "1.0",
            "generated_at": run_generated_at(),
            "data_date": next((date for date in data_dates if date), None),
            "symbol_count": len(profiles),
            "source_artifacts": {
                "stock_pattern_profiles": str(DEFAULT_PATTERN_PROFILE),
                "current_pattern_setups": str(DEFAULT_CURRENT_SETUPS),
            },
            "non_advice_boundary": "Hồ sơ tính cách mẫu hình dùng để quan sát lịch sử và bối cảnh hiện tại; không phải tín hiệu mua bán.",
        },
        "profiles": profiles,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build per-stock pattern personality profile JSON.")
    parser.add_argument("--pattern-profile", default=str(DEFAULT_PATTERN_PROFILE))
    parser.add_argument("--current-setups", default=str(DEFAULT_CURRENT_SETUPS))
    parser.add_argument("--research-dir", default="")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    pattern_payload = load_json(Path(args.pattern_profile).expanduser())
    setup_payload = load_json(Path(args.current_setups).expanduser())
    events = load_events(_discover_research_dir(args.research_dir or None))
    payload = build_payload(pattern_payload, setup_payload, events)
    out = Path(args.out).expanduser()
    if not out.is_absolute():
        out = (ROOT / out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "out": str(out), "symbol_count": payload["metadata"]["symbol_count"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
