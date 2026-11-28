# Quy ước làm việc & Phân công nhóm (`team-conventions.md`)

Tài liệu này chốt các quy tắc chung để cả 5 thành viên phối hợp code và dựng AWS mà không bị lệch cấu hình hay giẫm chân nhau.

---

## 1. Quy ước Git & Pull Request

- **Nhánh làm việc:** Luôn tách nhánh mới từ `main`, không push thẳng lên `main`.
  - Tính năng mới: `feat/<mo-ta-ngan>`
  - Sửa lỗi: `fix/<mo-ta-ngan>`
  - Tài liệu / cấu hình: `docs/<mo-ta-ngan>` hoặc `chore/<mo-ta-ngan>`
- **Commit message:** Dùng tiền tố rõ nghĩa như `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
- **Kiểm tra trước khi mở PR:** Chạy `npm.cmd run check` trong thư mục `backend/` để chắc chắn cả 6 hàm qua bước kiểm tra tĩnh và 54 unit test đều xanh.
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

Để tránh giẫm chân khi code và dựng hạ tầng song song, nhóm tách rõ hai vai trò sau:

- **Đầu mối mã nguồn (Code Owner):** **Nhật Anh** viết và bảo trì toàn bộ mã nguồn Frontend, Backend (`functions/`, `tests/`, `scripts/`, [infra/template.yaml](../infra/template.yaml)) để giữ hợp đồng API/WS thống nhất một mối.
- **Đầu mối dịch vụ AWS (AWS Service Owner):** **Vi, Hoài Nam, Duy, Trung Nam** phụ trách dựng, cấu hình, triển khai code từ repo này lên AWS và tự kiểm thử phần dịch vụ của mình. Hoài Nam và Duy cần nắm rõ luồng xử lý của các hàm mình deploy để tự đọc CloudWatch Log và xử lý sự cố.
- **Tài liệu Workshop:** Mỗi thành viên tự viết phần hướng dẫn **VI + EN** kèm ảnh chụp đã che thông tin nhạy cảm cho mảng mình làm, rồi gửi Trung Nam biên tập thống nhất thuật ngữ và ghép trang.

| Thành viên | Phạm vi phụ trách chính | Đầu ra bàn giao & phối hợp chéo |
| :--- | :--- | :--- |
| **Nhật Anh** | Viết và bảo trì mã nguồn Frontend (`Agent Portal`, `Simulator`), toàn bộ mã nguồn Backend (5 hàm lõi + 1 hàm AI Pha 2), bộ unit test, CI và mẫu IaC [infra/template.yaml](../infra/template.yaml); chốt hợp đồng REST/WS với nhóm. | Đóng gói `package:core` (5 file `.zip`) cho Hoài Nam và Duy; build bản production Frontend (`VITE_USE_MOCK=false`, qua `scripts/check-env.mjs`) gửi `dist/` cho Duy; test tích hợp End-to-End Frontend ↔ AWS thật trên CloudFront; nộp phần VI/EN Frontend + ảnh sạch bí mật cho Trung Nam. |
| **Vi** | Thiết kế sơ đồ trên `draw.io`, ước tính chi phí AWS Pricing Calculator, tạo AWS Budgets ($5/tháng), Cognito User Pool (`omniinbox-agent-pool`, tắt self-registration, tạo 2 user `--permanent`), 2 tham số SSM và bộ 6+1 IAM Role (6 role Lambda + `omni-apigw-cloudwatch-role`). | Gửi `User Pool ID`, `App Client ID` và 2 tài khoản test cho Nhật Anh; cấp quyền `ssm:GetParameter` trên `/omniinbox/prod/webhook_secret` cho Duy để chạy `setWebhook`; cập nhật `<WS_API_ID>` thật vào 3 role (`omni-normalizer-role`, `omni-api-role`, `omni-outbound-role`) ngay sau khi Duy dựng WebSocket API; đối chiếu kiến trúc thực tế với `.drawio`, thu thập 5 ảnh tối ưu chi phí sau triển khai, rà lại Cost Explorer sau 24–48 giờ khi Clean-up và viết phần VI/EN Architecture/Security/Cost. |
| **Hoài Nam** | Tạo 4 bảng DynamoDB (kèm GSI `gsi-all-by-time` và TTL `ttl`), SQS + DLQ (`maxReceiveCount=5`), dựng REST API Gateway (**6 route lõi** + Cognito Authorizer + CORS + Gateway Responses `Default 4XX/5XX` + throttling `20 rps / burst 40`; chỉ thêm route thứ 7 `POST /ai/suggest` nếu Go Pha 2) và deploy `omni-webhook-ingest`, `omni-message-normalizer`, `omni-api-handler`. | Gửi `REST_API_URL` cho Nhật Anh, Duy, Trung Nam; nhận `WS_ENDPOINT` (`https://`) và `ALLOWED_ORIGIN` (domain CloudFront) từ Duy để điền vào 3 Lambda rồi redeploy REST API; chốt chung cặp timeout `Normalizer / SQS` và phối hợp bật/tắt tạm `ENABLE_FAULT_INJECTION`, `ALLOW_SIMULATOR` (hoặc `REQUIRE_SIMULATOR_AUTH`) khi Trung Nam kiểm thử; chạy bộ tự kiểm thử REST/SQS/DDB và viết phần VI/EN mảng Inbound/Data/REST. |
| **Duy** | Tạo Telegram Bot thật, tự nhập token thẳng vào SSM `/omniinbox/prod/telegram_bot_token` (không gửi qua chat), chạy `setWebhook` kèm `secret_token`, dựng WebSocket API Gateway, S3 Private + CloudFront OAC (kèm Custom Error `403/404 -> /index.html`), deploy `omni-ws-handler`, `omni-outbound-sender` (và `omni-ai-suggester` nếu Go Ngày 9). | Gửi `WS_URL` (`wss://`) cho Nhật Anh, `WS_ENDPOINT` (`https://`) cho Hoài Nam và `<WS_API_ID>` cho Vi sửa 3 IAM Role; upload `dist/` từ Nhật Anh lên S3 + tạo CloudFront Invalidation `/*`, gửi domain CloudFront để khóa `ALLOWED_ORIGIN` trên các HTTP Lambda; sau khi chấm điểm xong chạy `deleteWebhook` và `/revoke` token trên `@BotFather`; viết phần VI/EN mảng Telegram/WS/Outbound/CloudFront. |
| **Trung Nam** | Tạo sẵn 6 CloudWatch Log Group `/aws/lambda/omni-*` (retention 7 ngày) trước khi deploy Lambda; bật Access/Execution Logging cho REST API & WebSocket API (2 Log Group `/aws/apigateway/omni-rest-prod-access`, `/aws/apigateway/omni-ws-prod-access` retention 7 ngày, gắn `omni-apigw-cloudwatch-role`); cấu hình Metric Filter `"[NORMALIZER_FAILURE]"` + 2 Alarm gửi SNS email. | Chạy 5 kịch bản kiểm thử hệ thống, đo hiệu năng thực tế `p50/p95` (CloudWatch Logs Insights + log `[LATENCY]` từ Frontend), quay Video Demo (3–5 phút), tổng hợp mục Troubleshooting (chỉ ghi lỗi gặp thật), biên tập thống nhất báo cáo VI/EN toàn nhóm và điều phối Clean-up theo [aws-deploy.md](./aws-deploy.md) sau khi chốt điểm. |

### Lưu ý phối hợp dễ bị quên

1. **Quyền đọc `webhook_secret` khi chạy `setWebhook`:** Vi cấp quyền `ssm:GetParameter` trên `/omniinbox/prod/webhook_secret` cho Duy; Duy giữ Telegram Bot Token và tự chạy `setWebhook`, tuyệt đối không gửi Bot Token qua chat.
2. **Chốt thống nhất 1 cặp Timeout `Normalizer / SQS`:** Hoài Nam và Trung Nam chọn chung `10s / 60s` (mặc định trong repo và [infra/template.yaml](../infra/template.yaml)) hoặc `5s / 30s` (test DLQ nhanh ~2–3 phút), luôn giữ đúng thứ tự `Timeout < 20s < Visibility`.
3. **Cổng Go/No-Go AI Ngày 9:** Cả nhóm cùng chốt (Nhật Anh và Duy xác nhận trạng thái `omni-ai-suggester` cùng model Bedrock đang `ACTIVE`); nếu No-Go thì không deploy AI, bỏ route `POST /ai/suggest` và xóa Bedrock khỏi sơ đồ `.drawio`.
4. **Tài khoản Lab hạn chế IAM & Clean-up cuối kỳ:** Nếu tài khoản AWS Lab không cho tạo Role tùy chỉnh, ghi trung thực tên Role thực tế đang dùng vào báo cáo. Clean-up chỉ thực hiện **sau khi có điểm** (Trung Nam điều phối xóa đúng thứ tự, Vi kiểm tra lại Cost Explorer và Resource Tag Editor sau 24–48 giờ ở cả `ap-southeast-1` và `us-east-1`).
