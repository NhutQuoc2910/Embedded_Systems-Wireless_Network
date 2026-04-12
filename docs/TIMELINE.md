# Timeline Thực Hiện Đồ Án AODV-UU (2 Tuần)

> **Phân bố điểm:**
> Ratio 1 — Lý thuyết 30% · Demo 35% · Phân tích mã nguồn 35%<br>
> Ratio 2 — Thuyết trình 60% · Báo cáo/slide/code 20% · Tham gia buổi khác 20%

---

## Tuần 1 — Nền tảng, Triển khai & Phân tích mã nguồn

### Ngày 1–2: Lý thuyết & Phân tích mã nguồn (Ratio 1: 30% + 35%)
- Đọc và phân tích tài liệu, tập trung vào RREQ, RREP, RERR, sequence number, routing table, HELLO mechanism
- Phân tích mã nguồn AODV-UU — ghi chú chi tiết cho từng file:
  - `main.c` — vòng lặp sự kiện, khởi tạo hệ thống
  - `aodv_socket.c` — gửi/nhận gói tin UDP port 654
  - `aodv_rreq.c` / `aodv_rrep.c` — flow xử lý route discovery
  - `aodv_rerr.c` / `aodv_hello.c` — bảo trì đường truyền
  - `routing_table.c` — cấu trúc dữ liệu bảng định tuyến, timeout
  - `nl.c` / `kaodv-netlink.c` — giao tiếp kernel↔user via Netlink
- Vẽ sơ đồ luồng hàm: transmitting / receiving / forwarding / processing
- Ghi chú các main data structures: `struct rt_table`, `struct rreq`, `struct rrep`, `struct rerr`
- **Viết báo cáo song song:** Part 01 (Introduction) + Part 02 (Related work) + List of Acronyms

### Ngày 3: Môi trường & Giải quyết rủi ro Kernel Module
- Cài đặt Ubuntu 24.04, các công cụ: `iproute2`, `tcpdump`, `iptables`, `iperf3`, `wireshark`
- Biên dịch `aodvd` từ source
- Xác nhận rủi ro `kaodv.ko` không tương thích kernel 5.x/6.x (`ip_queue` đã bị xóa)
- Triển khai giải pháp: thay `kaodv.ko` bằng `iptables` + `NFQUEUE`
- **Viết báo cáo song song:** Part 03 (Methodology) — mô tả môi trường, công cụ, lý do chọn giải pháp NFQUEUE

### Ngày 4: Xây dựng Topology bằng Network Namespace
- Viết `setup.sh`: tạo 3 node (`ns-A`, `ns-B`, `ns-C`) với `ip netns`
- Cấu hình `veth pair` kết nối các namespace
- Cấu hình `iptables NFQUEUE` độc lập trong từng namespace
- Kiểm tra kết nối cơ bản: `ping` qua lại giữa các node
- **Viết báo cáo song song:** Part 03 — vẽ sơ đồ kiến trúc demo (hình minh họa cho List of Figures)

### Ngày 5: Kịch bản Route Discovery — Capture & Phân tích
- Chạy `aodvd` trên cả 3 node với flag `-l` (verbose log)
- Bật `tcpdump` capture trên tất cả interface, lưu `.pcap`
- Thực hiện route discovery: `ns-A` → `ns-C` multi-hop qua `ns-B`
- Verify trong Wireshark: RREQ broadcast, RREP unicast, routing table update
- Ghi chú giá trị cụ thể: sequence number, hop count, TTL trong từng gói
- **Viết báo cáo song song:** Part 04 — kịch bản Route Discovery, chèn screenshot Wireshark

---

## Tuần 2 — Thử nghiệm, Đo lường & Hoàn thiện Báo cáo

### Ngày 8: Kịch bản Link Failure
- Trong khi traffic đang chạy, dùng `ip link set dev <veth> down` để cắt link
- Capture RERR phát ra, quan sát invalidate route cũ và route discovery mới
- Ghi nhận thời gian recovery (link down → route mới thiết lập)
- Lưu `.pcap` và log file riêng cho kịch bản này
- **Viết báo cáo song song:** Part 04 — kịch bản Link Failure, phân tích RERR

### Ngày 9: Đo hiệu năng (Demo 35%)
- Dùng `iperf3` đo throughput (TCP + UDP) trên topology 1-hop, 2-hop, 3-hop
- Dùng `ping -c 100` đo delay trung bình và packet loss theo số hop
- Đo routing overhead: tỷ lệ gói RREQ/RREP so với tổng traffic
- Ghi kết quả vào bảng so sánh (cho List of Tables trong báo cáo)
- **Viết báo cáo song song:** Part 04 — bảng kết quả, biểu đồ delay/throughput/packet loss

### Ngày 10: Hoàn thiện Part 04 & Part 05
- Hoàn chỉnh phần phân tích mã nguồn: flow diagram transmit/receive/forward, debug trace
- Viết phần **Challenges & Solutions**: rủi ro `kaodv.ko` và giải pháp NFQUEUE
- Viết Part 05 (Conclusions): tổng kết kết quả, hạn chế, hướng phát triển
- Hoàn thiện List of References (RFC 3561, paper gốc AODV-UU, tài liệu Linux kernel)
- Bổ sung APPENDIXES: source code `setup.sh`, `demo.sh`, raw log files

### Ngày 11: Hoàn thiện toàn bộ báo cáo Word
- Kiểm tra đủ cấu trúc theo rule:
  - [ ] Cover page với tên đề tài
  - [ ] Table of Contents (dùng MS Word cross-references)
  - [ ] List of Acronyms/Abbreviations
  - [ ] List of Figures (MS Word cross-references)
  - [ ] List of Tables (MS Word cross-references)
  - [ ] Part 01–05 đầy đủ
  - [ ] List of References
  - [ ] Appendixes
- Làm slide thuyết trình — tập trung vào 60% điểm thuyết trình:
  - Slide lý thuyết: AODV hoạt động như thế nào (30%)
  - Slide demo: 3 kịch bản với kết quả thực tế (35%)
  - Slide code analysis: flow diagram, data structures (35%)
- Viết `demo.sh` tự động hóa 3 kịch bản

### Ngày 12 : Rehearsal & Fix
- Chạy demo end-to-end, đảm bảo ổn định
- Luyện thuyết trình
- Fix lỗi phát sinh, review báo cáo lần cuối

---

## Tổng kết Deliverables

| Hạng mục | Nội dung | Liên quan đến |
| :--- | :--- | :--- |
| `setup.sh` | Script dựng topology 3 node với NFQUEUE | Demo 35% |
| `demo.sh` | Script chạy 3 kịch bản tự động | Demo 35% |
| `.pcap` files | Capture route discovery, link failure | Demo 35% |
| Log files | Output từ `aodvd -l` mỗi kịch bản | Demo 35% |
| Bảng kết quả | Delay, packet loss, throughput theo hop | Demo 35% |
| Flow diagrams | Luồng hàm transmit/receive/forward | Code analysis 35% |
| Báo cáo Word | Đủ cấu trúc theo Rules 2/2 | Báo cáo 20% |
| Slide | Bao phủ đủ lý thuyết + demo + code | Thuyết trình 60% |

---

> **Lưu ý:**
> - Ngày 6–7 (cuối tuần) nghỉ ngơi, chạy deadline.
> - Viết báo cáo **song song mỗi khi làm** — mỗi kịch bản làm xong là viết ngay phần tương ứng trong Part 04.