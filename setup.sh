#!/bin/bash

echo "==========================================="
echo "Bắt đầu thiết lập môi trường AODV-UU cho Nhóm"
echo "Người thực hiện: Châu Lê Quốc Sử"
echo "==========================================="

# 1. Cập nhật hệ thống và cài đặt thư viện cần thiết 
echo "[1/4] Đang cài đặt gcc, make và thư viện..."
sudo apt update
sudo apt install -y build-essential gcc make bison flex

# 2. Sửa lỗi "inline" bằng cách dùng sed (thay vì sửa tay) 
# Bước này cực kỳ quan trọng để Quốc không bị lỗi 'undefined reference'
echo "[2/4] Đang tự động sửa lỗi NS_INLINE trong các file header..."

# Sửa trong aodv_hello.h
sed -i 's/NS_INLINE void hello_update_timeout/void hello_update_timeout/g' aodv_hello.h

# Sửa trong routing_table.h
sed -i 's/static inline rt_table_t \*rt_table_update_timeout/rt_table_t \*rt_table_update_timeout/g' routing_table.h

# 3. Sửa lỗi CFLAGS trong Makefile để tương thích GCC mới 
echo "[3/4] Cấu hình Makefile để chạy chuẩn gnu89..."
sed -i 's/CFLAGS =/CFLAGS = -fgnu89-inline/g' Makefile

# 4. Tiến hành biên dịch 
echo "[4/4] Đang biên dịch aodvd..."
make clean
make aodvd

# Kiểm tra kết quả
if [ -f "aodvd" ]; then
    echo "==========================================="
    echo "CHÚC MỪNG! Build aodvd THÀNH CÔNG."
    echo "Quốc có thể chạy thử bằng lệnh: ./aodvd --help"
    echo "==========================================="
else
    echo "Lỗi: Không tìm thấy file aodvd. Kiểm tra lại log biên dịch bên trên."
fi
