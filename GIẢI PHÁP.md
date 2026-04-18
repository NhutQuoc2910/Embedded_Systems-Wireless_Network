# Giải Pháp Triển Khai AODV-UU Trên Linux Hiện Đại

## 1. Bối Cảnh & Vấn Đề

AODV-UU được viết từ năm 2003–2005, thiết kế cho Linux kernel 2.4 và 2.6. Khi clone repository về và chạy trên Ubuntu hiện đại (20.04/22.04 với kernel 5.x/6.x), nhóm xác định được 2 rủi ro nghiêm trọng:

**Rủi ro 1 — Kernel Module không tương thích:**
`kaodv.ko` phụ thuộc vào `ip_queue` — một API của kernel đã bị loại bỏ hoàn toàn từ kernel 3.5 trở đi. Việc chạy `make kaodv` trên kernel hiện đại sẽ thất bại với hàng loạt lỗi biên dịch. Vì vậy repo chuyển sang hướng `iptables + NFQUEUE`, trong đó `aodvd` xử lý toàn bộ queue và route discovery ở user space.

**Rủi ro 2 — Kernel Module không tương thích với Network Namespace:**
`kaodv.ko` được viết trước khi Linux có khái niệm Network Namespace (ra đời từ kernel 2.6.24). Khi chạy nhiều node trong các `netns` khác nhau, module kernel quan sát toàn bộ trên cùng một không gian vật lý, dẫn đến định tuyến chéo sai lệch hoặc Kernel Panic.

---

## 2. Giải Pháp: Thay `kaodv.ko` Bằng `iptables` + `NFQUEUE`

### Ý Tưởng Cốt Lõi

`kaodv.ko` thực chất chỉ làm một việc: **bắt gói tin IP chưa có route, giữ chúng lại trong hàng đợi** trong khi `aodvd` đi tìm đường. Nhiệm vụ này có thể thay thế hoàn toàn bằng `NFQUEUE` — hậu duệ hiện đại của `ip_queue`, có sẵn trên mọi Ubuntu 20.04/22.04 và **namespace-aware** theo thiết kế.

### So Sánh Kiến Trúc Cũ và Mới

| | Kiến trúc gốc (AODV-UU) | Giải pháp của nhóm |
| :--- | :--- | :--- |
| Bắt gói tin | `kaodv.ko` + `ip_queue` | `iptables` + `NFQUEUE` |
| Kernel API | `ip_queue` (đã bị xóa từ kernel 3.5) | `NFQUEUE` (có sẵn kernel 3.x trở lên) |
| Namespace support | Không (viết trước khi có netns) | Có (mỗi netns có chain iptables riêng) |
| Nguy cơ Kernel Panic | Có | Không |

---

## 3. Flow Luồng Dữ Liệu (Data Flow)

```text
Gói tin sinh ra tại Node A (VD: Ping Node C chưa có đường đi)
     ↓
[Node A - Kernel/iptables]: Gói tin đi qua OUTPUT chain (do chính A tạo ra)
     → Khớp rule: -A OUTPUT -j NFQUEUE --queue-num 0
     ↓
[Node A - Kernel]: Gói tin bị giữ lại ở trạng thái Pending
     → Packet ID được gửi lên User-space qua NFQUEUE socket
     ↓
[Node A - aodvd]: Đọc Packet ID từ NFQUEUE 0
     → Kiểm tra routing table nội tại (routing_table.c): KHÔNG có route đến Node C
     ↓
[Node A - aodvd]: Khởi động Route Discovery
     → Tạo gói RREQ (src=A, dst=C, seq++, hop_count=0)
     → Broadcast RREQ ra tất cả interface
     → Gói Ping gốc vẫn nằm chờ trong hàng đợi Kernel
     ↓
[Node B - Kernel/iptables]: Nhận RREQ, gói đi qua FORWARD chain
     → Khớp rule: -A FORWARD -j NFQUEUE --queue-num 0
     ↓
[Node B - aodvd]: Nhận RREQ
     → Ghi nhận reverse route về A vào routing table nội tại
     → Chưa có route đến C → tiếp tục Forward RREQ (hop_count++)
     ↓
[Node C - aodvd]: Nhận RREQ
     → Là đích đến (dst == self)
     → Tạo gói RREP (dst_seq, hop_count=0)
     → Unicast RREP ngược về Node A theo reverse route qua B
     ↓
[Node B - aodvd]: Nhận RREP
     → Ghi nhận forward route đến C vào routing table nội tại
     → Tiếp tục Forward RREP về Node A
     ↓
[Node A - aodvd]: Nhận RREP → Route Discovery thành công
     → Cập nhật routing table nội tại (routing_table.c):
        C reachable qua B, hop_count, sequence number, timeout
     → Đẩy route mới xuống Linux Kernel IP stack qua rtnetlink
        (để kernel biết forward gói tin đi đâu sau khi NF_ACCEPT)
     ↓
[Node A - aodvd]: Ra quyết định thả gói
     → Gọi nfq_set_verdict(Packet_ID, NF_ACCEPT)
     ↓
[Node A - Kernel]: Gói Ping gốc được giải phóng khỏi hàng đợi
     → Kernel tra bảng định tuyến (vừa được rtnetlink cập nhật)
     → Forward gói theo route mới: A → B → C
     ↓
[Node C]: Nhận gói Ping, gửi ICMP Reply ngược C → B → A
     (Reply đi theo forward route đã được thiết lập, không cần RREQ mới)
     ↓
Ping thành công. Route được cache trong routing table,
các gói tiếp theo đi thẳng mà không cần Route Discovery lại.
```

> **Lưu ý quan trọng:** `aodvd` duy trì **2 bảng định tuyến song song**:
> - **Bảng nội tại của `aodvd`** (`routing_table.c`): lưu thông tin AODV như sequence number, hop count, timeout, danh sách precursor.
> - **Bảng định tuyến của Linux Kernel** (cập nhật qua `rtnetlink`): để kernel biết forward gói tin đi đâu sau khi `NF_ACCEPT`.
>
> Cả 2 phải được cập nhật **trước** khi gọi `NF_ACCEPT`. Nếu chỉ cập nhật bảng nội tại mà chưa đẩy xuống kernel qua `rtnetlink`, gói tin sẽ được thả ra nhưng kernel không biết forward đi đâu — gói bị drop silently.

---

## 4. Triển Khai Cụ Thể

Trong repo hiện tại, phần hiện thực tương ứng nằm ở:

- `src/network/nfqueue.c` — mở queue `NFQUEUE 0`, nhận packet từ kernel và trả verdict
- `src/network/packet_input.c` — quyết định `ACCEPT`, `DROP`, hoặc buffer để route discovery
- `src/network/packet_queue.c` — giữ packet ID trong lúc chờ RREQ/RREP hoàn tất
- `src/network/nl.c` — chỉ còn dùng `rtnetlink` để cập nhật kernel routing table
- `scripts/setup.sh` — dựng topology và nạp rule NFQUEUE
- `scripts/build.sh` — cài dependency và build `aodvd`

### Cấu Hình NFQUEUE Trong `setup.sh`

```bash
#!/bin/bash

# Tạo các namespace
ip netns add ns-A
ip netns add ns-B
ip netns add ns-C

# Tạo veth pair A-B
ip link add veth-AB-a type veth peer name veth-AB-b
ip link set veth-AB-a netns ns-A
ip link set veth-AB-b netns ns-B

# Tạo veth pair B-C
ip link add veth-BC-b type veth peer name veth-BC-c
ip link set veth-BC-b netns ns-B
ip link set veth-BC-c netns ns-C

# Gán địa chỉ IP
ip netns exec ns-A ip addr add 10.0.1.1/24 dev veth-AB-a
ip netns exec ns-B ip addr add 10.0.1.2/24 dev veth-AB-b
ip netns exec ns-B ip addr add 10.0.2.1/24 dev veth-BC-b
ip netns exec ns-C ip addr add 10.0.2.2/24 dev veth-BC-c

# Bật interface
ip netns exec ns-A ip link set veth-AB-a up
ip netns exec ns-B ip link set veth-AB-b up
ip netns exec ns-B ip link set veth-BC-b up
ip netns exec ns-C ip link set veth-BC-c up

# Bật IP forwarding trong ns-B (node relay)
ip netns exec ns-B sysctl -w net.ipv4.ip_forward=1

# Cấu hình NFQUEUE trong từng namespace
# OUTPUT: bắt gói tin do chính node đó tạo ra
# FORWARD: bắt gói tin đi qua node đó với vai trò relay
ip netns exec ns-A iptables -A OUTPUT  -j NFQUEUE --queue-num 0
ip netns exec ns-A iptables -A FORWARD -j NFQUEUE --queue-num 0

ip netns exec ns-B iptables -A OUTPUT  -j NFQUEUE --queue-num 0
ip netns exec ns-B iptables -A FORWARD -j NFQUEUE --queue-num 0

ip netns exec ns-C iptables -A OUTPUT  -j NFQUEUE --queue-num 0
ip netns exec ns-C iptables -A FORWARD -j NFQUEUE --queue-num 0
```

### Chạy `aodvd` Trong Từng Namespace

```bash
# Mỗi node chạy daemon riêng biệt với verbose log
ip netns exec ns-A aodvd -l -i veth-AB-a              > log-A.txt 2>&1 &
ip netns exec ns-B aodvd -l -i veth-AB-b,veth-BC-b    > log-B.txt 2>&1 &
ip netns exec ns-C aodvd -l -i veth-BC-c              > log-C.txt 2>&1 &
```

### Capture Gói Tin Để Phân Tích

```bash
# Capture song song trên tất cả interface
ip netns exec ns-A tcpdump -i veth-AB-a -w capture-A.pcap &
ip netns exec ns-B tcpdump -i veth-AB-b -w capture-B.pcap &
ip netns exec ns-B tcpdump -i veth-BC-b -w capture-B2.pcap &
ip netns exec ns-C tcpdump -i veth-BC-c -w capture-C.pcap &
```

---

## 5. Kịch Bản Thử Nghiệm

### Kịch bản 1: Route Discovery
```bash
# ns-A ping tới ns-C (multi-hop qua ns-B)
# AODV sẽ tự động thực hiện RREQ → RREP trước khi ping thành công
ip netns exec ns-A ping -c 10 10.0.2.2
```
**Kết quả mong đợi:** Wireshark thấy RREQ broadcast từ A, RREP unicast từ C về A qua B, sau đó ICMP Reply thành công. Log file ghi lại sequence number và hop count của từng bước.

### Kịch bản 2: Link Failure & Recovery
```bash
# Chạy traffic liên tục
ip netns exec ns-C iperf3 -s &
ip netns exec ns-A iperf3 -c 10.0.2.2 -t 60 &

# Sau 15 giây, cắt link A-B
sleep 15
ip netns exec ns-A ip link set veth-AB-a down

# Quan sát RERR và quá trình tìm route mới trong log
tail -f log-A.txt
```
**Kết quả mong đợi:** RERR được phát ra, route cũ bị invalidate, AODV thực hiện route discovery mới. Ghi nhận thời gian recovery từ lúc link down đến khi traffic tiếp tục.

### Kịch bản 3: Đo Hiệu Năng
```bash
# Đo throughput bằng iperf3
ip netns exec ns-C iperf3 -s &
ip netns exec ns-A iperf3 -c 10.0.2.2 -t 30 -u -b 10M

# Đo delay và packet loss bằng ping
ip netns exec ns-A ping -c 100 -i 0.1 10.0.2.2
```
**Metrics thu thập:**
- Delay trung bình (ms)
- Packet loss (%)
- Throughput (Mbps)
- Routing overhead: số gói RREQ/RREP so với tổng gói tin
- Route Discovery Time: thời gian từ RREQ đầu tiên đến khi nhận RREP

---

## 6. Tại Sao Hướng Này Phù Hợp Với Đề Tài

Giải pháp NFQUEUE không chỉ giải quyết vấn đề kỹ thuật mà còn giữ nguyên giá trị cốt lõi của đề tài:

- `aodvd` vẫn là binary gốc từ AODV-UU, không bị chỉnh sửa logic giao thức.
- Vẫn chạy thật trên Linux, không phải simulator — kết quả log/trace phản ánh behavior thực.
- Vẫn capture được RREQ/RREP đầy đủ bằng `tcpdump`/Wireshark.
- Phần thay thế `kaodv.ko` → `NFQUEUE` trở thành nội dung **Challenges & Solutions** trong báo cáo, minh chứng nhóm thực sự hands-on với hệ thống thực tế.
