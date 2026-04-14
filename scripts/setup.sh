#!/bin/bash

echo "==========================================="
echo "Bắt đầu thiết lập môi trường AODV-UU cho Nhóm"
echo "Người thực hiện: Châu Lê Quốc Sử"
echo "==========================================="

# 1. Cập nhật hệ thống và cài đặt thư viện cần thiết
echo "[1/2] Đang cài đặt gcc, make và thư viện..."
sudo apt update
sudo apt install -y build-essential gcc make bison flex

# 2. Tiến hành biên dịch
echo "[2/2] Đang biên dịch aodvd..."
make clean
make aodvd

# Kiểm tra kết quả
if [ -f "aodvd" ]; then
    echo "==========================================="
    echo "CHÚC MỪNG! Build aodvd THÀNH CÔNG."
    echo "Chạy thử bằng lệnh: ./aodvd --help"
    echo "==========================================="
else
    echo "==========================================="
    echo "Lỗi: Không tìm thấy file aodvd."
    echo "Kiểm tra lại log biên dịch bên trên."
    echo "==========================================="
fi
