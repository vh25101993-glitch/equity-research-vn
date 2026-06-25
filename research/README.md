# Research — Nguồn gốc methodology của skill

Thư mục này chứa **source gốc** của các công thức đã được port vào skill `vn-technical-analysis` (mode PROFILE). Mục đích: **kiểm chứng độc lập** — người dùng có thể mở file gốc đối chiếu từng công thức với implementation trong skill.

> ⚠️ **Những file này KHÔNG cần thiết để chạy skill.** Skill đã port toàn bộ logic vào `vn-technical-analysis/references/*.md` (self-contained). File ở đây chỉ phục vụ transparency/reproducibility — để biết công thức từ đâu tới và verify độ chính xác.

## Map: file research → phần nào của skill

| File research (gốc) | Được port vào skill nào | Hàm/section cụ thể | Line gốc |
|---|---|---|---|
| `build_stock_profile_foundation.mjs` | `vn-technical-analysis/references/stock_profile_blocks.md` | 17 block profile (helpers + price_behavior, volatility, drawdown, VPCI, money_flow, effort_result, VAP, tail_risk, regime...) | `:36-189` (helpers), `:1566-1637` (các block), `:464-979` (indicators) |
| `build_current_pattern_setups.py` | `vn-technical-analysis/references/pattern_scoring.md` | 8 setup detection heuristic (bull_flag, ascending_triangle, double_bottom...) + `status_from_score` + `setup()` + `reader_note` | `:88-139` (status), `:142-274` (detectors) |
| `build_stock_pattern_profiles.py` | `vn-technical-analysis/references/pattern_scoring.md` (đã loại advanced) | 4 sub-score pattern profile (`_pattern_profile`) — **đã loại khỏi skill v2.0.0** vì cần event history | `:409-463` |
| `build_stock_pattern_personality_profiles.py` | `vn-technical-analysis/references/pattern_scoring.md` | `pattern_family` + `estimate_archetype` (bản rút gọn) | `:38-120` (family), `:299-355` (archetype note) |
| `generate_simple_stats_metric_dictionary.py` (excerpt) | `vn-technical-analysis/references/metric_guardrails.md` | `metric_dictionary()` — 13 metric với guardrail Việt | `:2238-2325` |

## Cách kiểm chứng

1. **Mở skill reference**: vd `vn-technical-analysis/references/stock_profile_blocks.md`, section "B6. tail_risk_profile".
2. **Đọc attribution line**: `Source: build_stock_profile_foundation.mjs:1023-1046`.
3. **Mở file gốc**: `research/build_stock_profile_foundation.mjs`, nhảy đến dòng 1023-1046.
4. **Đối chiếu**: công thức Python trong skill ↔ logic JavaScript gốc. Phải khớp (chỉ khác syntax JS→Python).

## Ghi chú quan trọng

### Nguồn gốc
- 5 file này đến từ project `market_stats` (dashboard nội bộ, KHÔNG public).
- Đưa vào đây **đã được sự đồng ý** — chỉ phục vụ reproducibility của skill.
- File giữ nguyên nội dung gốc (KHÔNG sửa) ngoại trừ `generate_simple_stats_metric_dictionary.py` là excerpt (chỉ hàm port, file gốc 2666 dòng quá lớn).

### Đã loại khỏi skill v2.0.0
- **4 sub-score pattern profile** (frequency/outcome/clean_path/freshness) trong `build_stock_pattern_profiles.py` — cần event history (mfe/mae) từ scanner lịch sử riêng, vnstock thuần không cung cấp.
- **7 archetype đầy đủ** + **3 lớp behavior hậu nghiệm** (after_buy/failure/bear_trap) trong `build_stock_pattern_personality_profiles.py` — cùng lý do.
- → Skill chỉ giữ **bản portable**: 8 setup heuristic + 5 family + 4 archetype ước lượng.

### Định dạng
- `.mjs` (ES module JavaScript): file gốc dashboard render — logic số học đọc được, syntax JS.
- `.py`: script build artifact — pandas + stdlib, chạy độc lập nếu có data.

### License
Source code trong `research/` thuộc về project `market_stats`. Sử dụng nội bộ cho mục đích kiểm chứng skill. KHÔNG redistribute thương mại.
