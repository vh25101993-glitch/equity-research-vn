#!/usr/bin/env python3
"""Excerpt từ generate_simple_stats.py — chỉ hàm metric_dictionary() được port vào skill.

File gốc đầy đủ (2666 dòng) nằm tại: market_stats/generate_simple_stats.py
Skill vn-technical-analysis chỉ port hàm này (dòng 2238-2325 của file gốc).
Các hàm khác trong file gốc (add_price_stats, build_payload, row_to_public...) KHÔNG được port.

Trích xuất này cho mục đích kiểm chứng: mở file này đối chiếu với
references/metric_guardrails.md section "15 Metric dictionary" của skill.
"""


def metric_dictionary() -> dict[str, dict[str, str]]:
    """Shared metric meanings surfaced by the UI and audit docs."""
    return {
        "return": {
            "label_vi": "Hiệu suất",
            "formula": "close_t / close_{t-window} - 1",
            "meaning": "Mức tăng giảm trong kỳ đang chọn.",
            "guardrail": "Không phải dự báo; chỉ mô tả phần đã xảy ra.",
        },
        "relative_return": {
            "label_vi": "So mốc",
            "formula": "return_object - return_benchmark",
            "meaning": "Khoảng cách tăng giảm so với VNINDEX, ngành hoặc rổ hiện tại.",
            "guardrail": "Số dương không có nghĩa độc lập với mốc; chỉ là đi tốt hơn trong kỳ.",
        },
        "moving_average_distance": {
            "label_vi": "Cách đường trung bình",
            "formula": "close_t / moving_average_n - 1",
            "meaning": "Giá hiện tại nằm trên hoặc dưới mặt bằng giá gần đây bao nhiêu.",
            "guardrail": "Không phải tín hiệu mua bán.",
        },
        "breadth": {
            "label_vi": "Bề rộng",
            "formula": "count(condition_true) / eligible_count",
            "meaning": "Tỷ lệ mã cùng tham gia tăng hoặc cùng đứng trên đường trung bình.",
            "guardrail": "Đây là số lượng mã, không đo độ lớn tăng giảm.",
        },
        "dispersion": {
            "label_vi": "Mức phân hóa",
            "formula": "std(cross_section_returns)",
            "meaning": "Độ chênh lệch hiệu suất giữa các mã trong cùng nhóm.",
            "guardrail": "Cao hoặc thấp không tự nói tốt/xấu; cần đọc cùng bề rộng.",
        },
        "liquidity": {
            "label_vi": "Thanh khoản",
            "formula": "close * volume; ratio = volume_t / average_volume_window",
            "meaning": "Mức hoạt động giao dịch theo giá trị hoặc khối lượng so trung bình.",
            "guardrail": "Giá trị giao dịch là ước tính từ giá đóng cửa nhân khối lượng.",
        },
        "correlation": {
            "label_vi": "Đi cùng",
            "formula": "corr(return_a, return_b)",
            "meaning": "Hai chuỗi tăng giảm cùng nhịp ở mức nào.",
            "guardrail": "Không nói chuỗi nào dẫn trước và không chứng minh quan hệ nguyên nhân.",
        },
        "beta_r2": {
            "label_vi": "Mức phản ứng / độ khớp",
            "formula": "beta = cov(stock, benchmark) / var(benchmark); r2 = regression_fit",
            "meaning": "Mã phản ứng mạnh hay nhẹ hơn mốc, kèm độ đáng đọc của phép so sánh.",
            "guardrail": "Beta thấp không đồng nghĩa ít rủi ro; R² thấp thì không đọc beta quá sâu.",
        },
        "drawdown": {
            "label_vi": "Mức giảm từ đỉnh",
            "formula": "close_t / rolling_peak - 1",
            "meaning": "Giá đang thấp hơn đỉnh gần nhất bao nhiêu.",
            "guardrail": "Nhạy với cửa sổ quan sát và dữ liệu chưa điều chỉnh sự kiện vốn.",
        },
        "rolling_return": {
            "label_vi": "Lợi nhuận lăn",
            "formula": "close_t / close_{t-window} - 1 across all historical windows",
            "meaning": "Phân phối các cửa sổ tăng giảm cùng độ dài đã xảy ra trong lịch sử.",
            "guardrail": "Các cửa sổ chồng lấp không phải quan sát độc lập và không phải xác suất tương lai.",
        },
        "historical_episode": {
            "label_vi": "Đợt lịch sử",
            "formula": "peak/trough/recovery dates from observed close path",
            "meaning": "Các đợt đi xuống, hồi phục hoặc tăng từ đáy lên đỉnh trong mẫu đang có.",
            "guardrail": "Rất nhạy với ngày bắt đầu mẫu và trạng thái điều chỉnh dữ liệu.",
        },
        "data_adjustment": {
            "label_vi": "Điều chỉnh dữ liệu",
            "formula": "raw price vs adjusted price governance",
            "meaning": "Cho biết dữ liệu giá đã được xác nhận điều chỉnh corporate actions hay chưa.",
            "guardrail": "Khi chưa xác nhận điều chỉnh, các metric dài hạn chỉ nên đọc như quan sát tham khảo.",
        },
        "data_confidence": {
            "label_vi": "Độ tin cậy dữ liệu",
            "formula": "coverage, zero-volume ratio, membership basis, relationship fit",
            "meaning": "Cho biết metric nên đọc chắc hay chỉ đọc tham khảo.",
            "guardrail": "Không che giấu bất định; luôn đọc cùng kỳ và nền dữ liệu.",
        },
        "classification_history": {
            "label_vi": "Lịch sử phân ngành",
            "formula": "ticker + sector/industry/subindustry + effective_from/effective_to",
            "meaning": "Cho biết ngành của cổ phiếu được đọc theo snapshot hiện tại hay theo ngày hiệu lực.",
            "guardrail": "Nếu chưa có lịch sử phân ngành, so sánh ngành quá khứ chỉ là tham chiếu theo phân ngành hiện tại.",
        },
    }
