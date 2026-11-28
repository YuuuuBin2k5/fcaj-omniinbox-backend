# Quy ước làm việc & Phân công nhóm (`team-conventions.md`)

Tài liệu này chốt các quy tắc chung để cả 5 thành viên phối hợp code và dựng AWS mà không bị lệch cấu hình hay giẫm chân nhau.

---

## 1. Quy ước Git & Pull Request

- **Nhánh làm việc:** Luôn tách nhánh mới từ `main`, không push thẳng lên `main`.
  - Tính năng mới: `feat/<mo-ta-ngan>`
  - Sửa lỗi: `fix/<mo-ta-ngan>`
  - Tài liệu / cấu hình: `docs/<mo-ta-ngan>` hoặc `chore/<mo-ta-ngan>`
- **Commit message:** Dùng tiền tố rõ nghĩa như `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
- **Kiểm tra trước khi mở PR:** Chạy `npm.cmd run check` trong thư mục `backend/` để chắc chắn cả 6 hàm qua bước kiểm tra tĩnh và 45 unit test đều xanh.
- **Không commit file tạm:** Thư mục `dist/`, `node_modules/`, file `.zip` và `.env.local` đều đã nằm trong [.gitignore](../.gitignore). Nếu build thử `package:core` ở máy thì xóa `dist/` trước khi commit.

---

## 2. Quy ước viết code AWS Lambda trong repo

Toàn bộ mã nguồn hàm nằm trong `functions/<ten-ham>/index.mjs` và phải tuân theo kiểm tra tự động ở [verify-lambdas.mjs](../scripts/verify-lambdas.mjs):

1. **ESM thuần Node.js 22.x (`index.mjs`):** Chỉ import các module chuẩn `node:*` và `@aws-sdk/*` có sẵn trên runtime Lambda. Không thêm thư viện npm bên ngoài vào code chạy thật để các bạn deploy bằng cách copy-paste hoặc upload file `.zip` 1 file lên Console là chạy ngay, không phải dựng Lambda Layer.
2. **Tách `createHandler(deps = {})`:** Mỗi hàm đều export cả `createHandler(deps)` (để file test truyền mock DynamoDB/SQS/SSM/fetch vào chạy offline) và `export const handler = createHandler()` cho AWS Lambda gọi.
3. **Không chứa dữ liệu nhạy cảm hay model đã ngừng hỗ trợ:** Tuyệt đối không ghi token Telegram, khóa AWS hay model Claude 3 Haiku đã ngừng hỗ trợ vào code.
4. **Comment đúng chỗ cần thiết:** Viết comment tiếng Việt ngắn gọn ở những chỗ dễ gây hiểu nhầm hoặc có bẫy kỹ thuật (ví dụ lý do khóa idempotency phải kèm `chat.id`, lý do chờ 20 giây cho `STALE_LOCK_MS`, hay lý do không xóa `unreadCount` khi gửi lỗi). Không viết comment giải thích lại những dòng code hiển nhiên.

---

## 3. Quy ước nghiệp vụ & Bảo mật chung

- **Phân biệt rõ kênh thật và kênh mô phỏng:** `telegram` là kênh thật duy nhất (nhận webhook thật và gọi Telegram Bot API gửi ra ngoài). `shopee`, `zalo`, `webchat` là 3 kênh mô phỏng do trang Simulator gửi vào để test đa kênh, hệ thống chỉ lưu DB và gắn `deliveredVia: "simulator"`.
- **AI là phần tùy chọn pha 2:** Hàm `omni-ai-suggester` không nằm trong gói `package:core`. Chỉ deploy hàm này sau khi nhóm chốt **Go** ở Ngày 9 (khi luồng chính và bảo mật đã chạy ổn).
- **Quản lý secret an toàn:**
  - Không gửi token bot, webhook secret hay mật khẩu tài khoản Cognito qua chat nhóm, không commit vào Git và luôn che kỹ khi chụp ảnh báo cáo.
  - Telegram Bot Token do **Duy** tự nhập thẳng vào SSM Parameter Store (`/omniinbox/prod/telegram_bot_token`).
  - Trong tài liệu chỉ dùng placeholder như `<ACCOUNT_ID>`, `<REST_API_ID>`, `<WS_API_ID>`, `<WEBHOOK_SECRET>`, `<TELEGRAM_BOT_TOKEN>`.

---

## 4. Phân công đầu mối giữa code và dịch vụ AWS

| Thành viên | Đầu việc chính trong dự án |
| :--- | :--- |
| **Nhật Anh** | Viết mã nguồn Frontend (`Agent Portal`, `Simulator`) và toàn bộ mã nguồn Backend trong repo này; đồng bộ hợp đồng API/WS với nhóm. |
| **Vi** | Thiết kế kiến trúc trên `draw.io`, ước tính chi phí AWS Pricing Calculator, tạo Cognito User Pool, SSM Parameter Store và bộ IAM Role cho các Lambda. |
| **Hoài Nam** | Tạo 4 bảng DynamoDB (kèm GSI và TTL), SQS + DLQ, dựng REST API Gateway (7 route + Cognito Authorizer + CORS) và deploy 3 hàm `omni-webhook-ingest`, `omni-message-normalizer`, `omni-api-handler`. |
| **Duy** | Tạo Telegram Bot thật + `setWebhook`, dựng WebSocket API Gateway, S3 Private + CloudFront OAC, deploy `omni-ws-handler`, `omni-outbound-sender` (và `omni-ai-suggester` nếu làm pha 2). |
| **Trung Nam** | Tạo sẵn 6 CloudWatch Log Group (retention 7 ngày), cấu hình Metric Filter `[NORMALIZER_FAILURE]` + 2 Alarm gửi SNS email, chạy 5 kịch bản kiểm thử và biên tập báo cáo. |
