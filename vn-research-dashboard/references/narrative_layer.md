# Narrative Layer cho Financial HTML

Tài liệu này mô tả cách bổ sung narrative publication vào dashboard tài chính mà không làm mất khả năng tra cứu KPI, chart và bảng.

## 1. Kiến trúc ba tầng

```text
Evidence layer
  claims + sources + formula + uncertainty
        ↓
Analytical layer
  KPI + chart + table + valuation + sensitivity
        ↓
Narrative layer
  chapter question + claim graph + counterpoint + centerpiece
```

Narrative layer không được tạo số liệu mới. Mọi nội dung phải resolve về claim hoặc dataset đã audit.

## 2. Chapter anatomy

Mỗi chapter trọng yếu dùng cấu trúc:

```text
Guiding question
→ Provisional thesis
→ Evidence/KPI
→ Mechanism or comparison
→ Counterpoint
→ Mini-conclusion
→ Risk of interpretation
→ Takeaway/monitoring metric
```

Ví dụ ngân hàng:

```json
{
  "chapter_id": "ch-asset-quality",
  "title": "Chất lượng tài sản",
  "guiding_question": "Tăng trưởng tín dụng có đánh đổi bằng rủi ro nợ xấu không?",
  "provisional_thesis": "Tín dụng tăng nhanh nhưng tín hiệu chất lượng tài sản phân hóa.",
  "claim_ids": ["CLM-CREDIT-01", "CLM-G2-02", "CLM-NPL-03"],
  "centerpiece_visual_id": "VIS-CREDIT-CASCADE",
  "counterpoint_id": "CP-ASSET-01",
  "mini_conclusion": "Chưa có căng thẳng hệ thống nhưng nợ nhóm 2 là chỉ báo cần theo dõi.",
  "risk_of_interpretation": "Dữ liệu quý có thể bị ảnh hưởng bởi write-off và phân loại lại.",
  "takeaway": "Theo dõi đồng thời tăng trưởng tín dụng, nợ nhóm 2 và credit cost."
}
```

## 3. Claim graph

Graph dùng để thể hiện logic bằng chứng, không dùng để trang trí.

### Quan hệ

| Relation | Ý nghĩa |
|---|---|
| `SUPPORTS` | Claim A củng cố claim B |
| `CONTRADICTS` | Claim A tạo bằng chứng ngược với B |
| `QUALIFIES` | A giới hạn phạm vi hoặc độ mạnh của B |
| `EXPLAINS` | A giải thích cơ chế dẫn tới B |
| `DERIVED_FROM` | A được tính từ B |
| `SYNTHESIZES` | A tổng hợp nhiều claim |
| `DEPENDS_ON` | A chỉ đúng khi B giữ |
| `INVALIDATES_IF` | B xảy ra sẽ làm A mất hiệu lực |
| `REFERENCES` | Quan hệ tham chiếu mềm |
| `SUPERSEDES` | A thay thế claim cũ B |

### Quy tắc

- Mỗi node phải tồn tại trong evidence ledger/claims.
- Không tạo edge vòng không có ý nghĩa phân tích.
- `DERIVED_FROM` phải khớp `input_claim_ids` và formula.
- `CONTRADICTS` không đồng nghĩa một claim sai; có thể phản ánh phân hóa kỳ, phạm vi hoặc định nghĩa.

## 4. Counterpoint

Counterpoint tốt phải trả lời bốn câu hỏi:

1. Luận điểm chính là gì?
2. Bằng chứng mạnh nhất ủng hộ là gì?
3. Phản biện mạnh nhất là gì?
4. Metric/trigger nào sẽ phân định hai phía?

Ví dụ:

```json
{
  "counterpoint_id": "CP-NIM-01",
  "chapter_id": "ch-nim",
  "question": "NIM ổn định có thực sự phản ánh sức mạnh hoạt động?",
  "main_view": {
    "statement": "CASA phục hồi và chi phí vốn giảm hỗ trợ NIM.",
    "claim_ids": ["CLM-CASA-01", "CLM-COF-02"]
  },
  "opposing_view": {
    "statement": "NIM có thể được duy trì nhờ lợi suất cho vay cao hơn, đi kèm khẩu vị rủi ro lớn hơn.",
    "claim_ids": ["CLM-YIELD-03", "CLM-G2-04"]
  },
  "synthesis": "Đánh giá NIM cùng credit cost và nợ nhóm 2.",
  "decision_metrics": ["Nợ nhóm 2", "Credit cost", "LLR"]
}
```

## 5. Narrative centerpiece

Centerpiece là visual kể chuyện theo bước. Chỉ dùng khi thứ tự hoặc cơ chế là phần chính của câu hỏi.

### Dạng phù hợp

- earnings bridge;
- cash-conversion cascade;
- credit-quality cascade;
- funding-to-NIM;
- balance-sheet pressure map;
- capital constraint path;
- policy timeline;
- scenario path.

### Sticky-scroll

Desktop:

```text
Narrative steps (scroll) | Sticky visual/evidence panel
```

Mobile/print:

```text
Step card 1
Step card 2
Step card 3
```

Yêu cầu:

- mỗi step có `step_id`, title, body và claim IDs;
- visual phải có fallback;
- hỗ trợ click và bàn phím;
- tôn trọng `prefers-reduced-motion`;
- không dùng animation để che giấu dữ liệu;
- không tạo sticky-scroll nếu chỉ có 1–2 ý rời rạc.

## 6. Reader/Research mode

Hai mode dùng cùng DOM và dataset.

### Reader

- claim ID và graph chi tiết được ẩn;
- nguồn/công thức hiển thị qua disclosure;
- giữ câu hỏi, KPI, chart, counterpoint ngắn và takeaway.

### Research

- hiện evidence class/status;
- nguồn, kỳ, đơn vị, formula/input;
- uncertainty;
- claim graph;
- counterpoint evidence;
- methodology notes.

Mặc định:

```html
<html data-view="reader">
```

Toggle phải cập nhật `aria-pressed` và lưu lựa chọn trong `localStorage` khi khả thi.

## 7. Progressive disclosure

Dùng `<details>` thay vì div ẩn bằng JS:

```html
<details class="evidence-disclosure research-detail">
  <summary>Nguồn, cách tính và giới hạn</summary>
  <div class="evidence-grid">...</div>
</details>
```

Print CSS mở toàn bộ nội dung. Khi JS lỗi, người đọc vẫn thao tác được.

## 8. Mapping theo loại doanh nghiệp

### Phi tài chính

- growth/margin → earnings bridge;
- LNST/CFO/FCF → cash conversion;
- tồn kho/phải thu/nợ → balance-sheet pressure;
- valuation → assumptions and invalidation triggers.

### Ngân hàng

- CASA/COF/NIM/NII;
- tín dụng/G2/NPL/provision/credit cost;
- RWA/CAR/growth/ROE/PB.

### Chứng khoán

- thanh khoản/môi giới;
- margin book/NII/risk;
- tự doanh/volatility;
- vốn/ROE/valuation.

## 9. QA checklist

- [ ] Mỗi chapter có guiding question và takeaway.
- [ ] Claim ID không trùng, không orphan.
- [ ] Graph relation hợp lệ.
- [ ] Counterpoint có hai phía và decision metrics.
- [ ] Centerpiece có mobile/print fallback.
- [ ] Reader/Research mode không làm thay đổi số liệu.
- [ ] Disclosure dùng semantic HTML.
- [ ] Không scroll ngang ở 390 px.
- [ ] Print hiển thị toàn bộ research content.
- [ ] Illustrative mechanism có nhãn rõ.
