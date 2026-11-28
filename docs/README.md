# Tài liệu Backend — OmniInbox

Thư mục này tổng hợp quy ước làm việc nhóm, thiết kế kiến trúc AWS, cấu trúc bảng DynamoDB, đặc tả API và hướng dẫn dựng hạ tầng cho phần backend của dự án **OmniInbox** (AWS First Cloud Journey).

```text
docs/
├── README.md            # Mục lục tra cứu nhanh
├── team-conventions.md  # Quy ước Git, chuẩn viết Lambda, bảo mật và phân công nhóm
├── architecture.md      # Sơ đồ hệ thống Serverless và các luồng chạy chính
├── database-schema.md   # Cấu trúc 4 bảng DynamoDB, khóa chống trùng và trạng thái
├── api-spec.md          # Đặc tả 7 REST API, WebSocket và 3 sự kiện thời gian thực
├── setup-and-test.md    # Chạy local, unit test, đóng gói ZIP và test curl/wscat
└── aws-deploy.md        # Thông số Lambda, biến môi trường, IAM Policy, Alarm và Clean-up
```

## Tra cứu nhanh theo việc cần làm

| Khi bạn cần... | Mở file |
| :--- | :--- |
| Xem quy tắc Git, PR, viết code Lambda và ai giữ phần nào | [team-conventions.md](./team-conventions.md) |
| Hiểu luồng nhận tin, WebSocket và lý do chọn kiến trúc | [architecture.md](./architecture.md) |
| Tạo bảng DynamoDB, xem khóa chính, GSI và TTL | [database-schema.md](./database-schema.md) |
| Ghép frontend với REST API, WebSocket và xử lý mã lỗi | [api-spec.md](./api-spec.md) |
| Chạy test ở máy, đóng gói file ZIP hoặc test webhook bằng `curl` | [setup-and-test.md](./setup-and-test.md) |
| Dựng dịch vụ trên AWS Console, gắn IAM Role, Alarm và dọn tài nguyên | [aws-deploy.md](./aws-deploy.md) |
