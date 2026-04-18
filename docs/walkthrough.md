# Walkthrough: Kịch Bản Thử Nghiệm AODV-UU Trên Linux Hiện Đại

## Mục tiêu

Repo hiện chạy theo hướng `iptables + NFQUEUE + aodvd` trong user space.
`kaodv.ko` vẫn còn trong repo như mã legacy để tham khảo, nhưng không còn là
đường chạy mặc định cho demo Linux hiện đại.

## Yêu cầu môi trường

- OS: Ubuntu 20.04 / 22.04 / 24.04 hoặc WSL2 Ubuntu
- Quyền: `root` hoặc `sudo`
- Gói cần có: `build-essential`, `pkg-config`, `libnetfilter-queue-dev`,
  `iproute2`, `iptables`, `tcpdump`, `iperf3`, `wireshark`

## Bước 1: Build `aodvd`

```bash
git clone https://github.com/NhutQuoc2910/Embedded_Systems-Wireless_Network.git
cd Embedded_Systems-Wireless_Network

chmod +x scripts/build.sh
./scripts/build.sh
```

Nếu đã cài đủ dependency, có thể build thủ công:

```bash
make clean
make aodvd
ls -la aodvd
```

## Bước 2: Dựng topology namespace

Script `scripts/setup.sh` hỗ trợ 4 mode:

- `topology`: chỉ tạo namespace và veth
- `nfqueue`: chỉ nạp rule `iptables`/`NFQUEUE`
- `all`: dựng topology + NFQUEUE
- `cleanup`: dọn namespace

Để kiểm tra baseline trước khi bật NFQUEUE, chạy topology trước:

```bash
chmod +x scripts/setup.sh
sudo ./scripts/setup.sh topology
```

Topology tạo ra:

```text
[ns-A] ---- veth-AB ---- [ns-B] ---- veth-BC ---- [ns-C]
10.0.1.1                10.0.1.2   10.0.2.1                10.0.2.2
```

Script cũng:

- bật `lo` và các `veth`
- bật `ip_forward` tại `ns-B`
- thêm default route tại `ns-A` và `ns-C` để packet đi được vào `OUTPUT`
  chain khi cần route discovery

## Bước 3: Kiểm tra baseline

```bash
# Direct link: phải thành công
sudo ip netns exec ns-A ping -c 3 10.0.1.2
sudo ip netns exec ns-B ping -c 3 10.0.2.2

# Multi-hop khi chưa chạy AODV: phải timeout hoặc fail
sudo ip netns exec ns-A ping -W 1 -c 3 10.0.2.2
```

## Bước 4: Khởi động `aodvd`

Mở 3 terminal riêng.

Terminal 1:

```bash
sudo ip netns exec ns-A ./aodvd -l -i veth-AB-a
```

Terminal 2:

```bash
sudo ip netns exec ns-B ./aodvd -l -i veth-AB-b,veth-BC-b
```

Terminal 3:

```bash
sudo ip netns exec ns-C ./aodvd -l -i veth-BC-c
```

Ý nghĩa flag:

- `-i`: chỉ định interface AODV lắng nghe
- `-l`: ghi log ra `/var/log/aodvd.log`

Trong bản build hiện tại, log vẫn xuất hiện trên stdout khi chạy foreground,
vì binary đang bật `DEBUG`.

## Bước 5: Bật NFQUEUE

Sau khi `aodvd` đã chạy trên cả 3 namespace:

```bash
sudo ./scripts/setup.sh nfqueue
```

Rule hiện tại:

- bypass traffic trực tiếp cùng subnet
- bypass AODV control packet UDP port `654`
- queue phần traffic còn lại qua `NFQUEUE 0`

## Bước 6: Bật capture

Mở terminal thứ 4:

```bash
sudo ip netns exec ns-A tcpdump -i veth-AB-a -w capture-A.pcap -v &
sudo ip netns exec ns-B tcpdump -i veth-AB-b -w capture-B-left.pcap -v &
sudo ip netns exec ns-B tcpdump -i veth-BC-b -w capture-B-right.pcap -v &
sudo ip netns exec ns-C tcpdump -i veth-BC-c -w capture-C.pcap -v &
```

## Kịch bản 1: Route Discovery

```bash
sudo ip netns exec ns-A ping -c 10 10.0.2.2
```

Kết quả mong đợi:

- vài echo đầu bị delay trong lúc route discovery
- sau khi route được thêm vào kernel routing table, ping reply bình thường
- Wireshark thấy chuỗi `RREQ -> RREP -> ICMP`

Các log thường gặp trong source hiện tại:

- Node A: `Assembled RREQ`, `Received RREP`, `Inserting ... next hop ...`
- Node B: `forwarding RREQ`, `Forwarding RREP`
- Node C: `Assembled RREP`

Wireshark filter:

```bash
udp.port == 654
```

## Kịch bản 2: Link Failure & Recovery

Tạo traffic:

```bash
sudo ip netns exec ns-C iperf3 -s
sudo ip netns exec ns-A iperf3 -c 10.0.2.2 -t 60
```

Cắt link sau 15 giây:

```bash
sleep 15
sudo ip netns exec ns-A ip link set veth-AB-a down
```

Khôi phục link:

```bash
sleep 10
sudo ip netns exec ns-A ip link set veth-AB-a up
```

Điểm cần quan sát:

- log `Received RERR` hoặc route timeout/invalidation
- traffic bị gián đoạn trong khoảng recovery
- route discovery mới sau khi link quay lại

## Dọn dẹp

```bash
sudo pkill -f aodvd || true
sudo pkill -f tcpdump || true
sudo pkill -f iperf3 || true
sudo ./scripts/setup.sh cleanup
```

## Output mong đợi

```text
capture-A.pcap
capture-B-left.pcap
capture-B-right.pcap
capture-C.pcap
```

## Troubleshooting

| Triệu chứng | Nguyên nhân có thể | Cách xử lý |
| :--- | :--- | :--- |
| `make: command not found` | Đang chạy trên Windows shell hoặc chưa cài toolchain Linux | Dùng Ubuntu/WSL2 Ubuntu và chạy `./scripts/build.sh` |
| `Could not initialize NFQUEUE packet capture` | Thiếu `libnetfilter-queue-dev`, chưa có rule `NFQUEUE`, hoặc thiếu quyền root | Chạy lại `./scripts/build.sh`, rồi `sudo ./scripts/setup.sh nfqueue` |
| Ping trực tiếp A→B không đi | Namespace/veth chưa lên | Chạy lại `sudo ./scripts/setup.sh topology` |
| Ping A→C fail ngay cả khi `aodvd` đã chạy | Chưa bật `NFQUEUE` hoặc daemon chạy sai interface | Kiểm tra `sudo ./scripts/setup.sh nfqueue` và flag `-i` |
| Không thấy gói AODV trong Wireshark | Chưa capture đúng interface hoặc filter sai | Dùng `udp.port == 654` và capture trên cả 4 interface |
