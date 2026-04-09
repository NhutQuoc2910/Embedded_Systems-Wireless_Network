# Embedded_Systems_Wireless_Network

Đồ án Hệ thống nhúng Mạng không dây

### Cấu trúc repo

```text
AODV-UU/
├── src/      # Mã nguồn chính của daemon aodvd
│   ├── core/      # Logic lõi, main và các định nghĩa chung
│   ├── protocol/  # Các module xử lý giao thức AODV (RREQ, RREP, RERR, Hello)
│   ├── network/   # Xử lý Socket, Netlink và tương tác mạng
│   ├── routing/   # Quản lý bảng định tuyến và danh sách tìm kiếm
│   └── utils/     # Các tiện ích: timer, list, debug
├── kernel/   # Mã nguồn module nhân Linux (trước là lnx/)
├── sim/      # Tích hợp mô phỏng NS-2 (trước là ns-2/)
├── docs/     # Tài liệu dự án
├── scripts/  # Các script hỗ trợ (setup.sh)
├── extra/    # Tài liệu tham khảo (RFC, ChangeLog, GPL)
└── Makefile  # File build chính (ở root)
```
