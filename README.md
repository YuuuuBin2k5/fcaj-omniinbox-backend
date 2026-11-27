# OmniInbox Backend — AWS Lambda Functions (`Node.js 22.x / arm64`)

Mã nguồn backend Serverless Event-Driven cho hệ thống **OmniInbox** (AWS First Cloud Journey — Region `ap-southeast-1`). Toàn bộ **5 hàm Lambda lõi** (+ **1 hàm AI Pha 2 tùy chọn**) được viết thuần **ESM (`index.mjs`)**, chỉ dùng `node:*` và `@aws-sdk/*` có sẵn trong runtime AWS Lambda `Node.js 22.x`, giúp các thành viên phụ trách AWS dễ dàng **copy-paste trực tiếp** vào Lambda Console hoặc **upload `.zip` chuẩn POSIX**.

---

## 1. Danh mục 6 Hàm Lambda & Phân công Triển khai AWS

| Tên hàm Lambda | Nhóm | Runtime / Arch / Memory / Timeout | IAM Role (`Vi`) | Chủ sở hữu AWS |
| :--- | :---: | :--- | :--- | :--- |
| `omni-webhook-ingest` | **Lõi** | `nodejs22.x` · `arm64` · `128 MB` · `5 s` | `omni-ingest-role` | **Hoài Nam** |
| `omni-message-normalizer` | **Lõi** | `nodejs22.x` · `arm64` · `256 MB` · `10 s` *(SQS visibility `60 s`)* | `omni-normalizer-role` | **Hoài Nam** |
| `omni-api-handler` | **Lõi** | `nodejs22.x` · `arm64` · `128 MB` · `10 s` | `omni-api-role` | **Hoài Nam** |
| `omni-ws-handler` | **Lõi** | `nodejs22.x` · `arm64` · `128 MB` · `10 s` | `omni-ws-role` | **Duy** |
| `omni-outbound-sender` | **Lõi** | `nodejs22.x` · `arm64` · `256 MB` · `15 s` | `omni-outbound-role` | **Duy** |
| `omni-ai-suggester` | **Pha 2 (Tùy chọn)** | `nodejs22.x` · `arm64` · `256 MB` · `15 s` | `omni-ai-role` | **Duy** *(chỉ deploy nếu Go Ngày 9)* |

> [!CAUTION]
> **Không deploy `omni-ai-suggester` trước cổng Go/No-Go Ngày 9** và tuyệt đối không hard-code model đã ngừng hỗ trợ (`claude-3-haiku`); nếu Go ở Ngày 9, phải kiểm tra model đang `ACTIVE` qua `aws bedrock list-foundation-models --region ap-southeast-1`.

---

## 2. Các Cải tiến & Cơ chế Độ tin cậy Đã Tích hợp Sẵn

1. **UUID-safe `resolveAgentId()` & REST v1/HTTP v2 JWT claims:** Trong `omni-api-handler`, `omni-outbound-sender`, `omni-ai-suggester` và frontend `auth.js`, ưu tiên `claims.email` khi Cognito sinh `cognito:username` dạng UUID.
2. **Chống gửi chồng chéo (Atomic Ownership Guard `409`):** Trước khi gọi Telegram API, `omni-outbound-sender` từ chối với HTTP `409 CONVERSATION_ASSIGNED_TO_OTHER` nếu hội thoại đang thuộc đồng nghiệp khác, hoặc dùng `ConditionExpression` (`assignedAgent = :unassigned`) để tranh quyền nguyên tử cho ca `unassigned`. Không còn cảnh 2 nhân viên cùng trả lời đè lên 1 khách.
3. **Bảo vệ `unreadCount`, `lastMessage` & hướng tin cuối (`lastMessageDirection`):**
   - `PATCH /conversations/{conversationId}` hỗ trợ `expectedLastMessageAt` tránh xóa nhầm `unreadCount` khi có tin khách mới đang trên đường tới.
   - `omni-outbound-sender` bảo toàn `unreadCount`/`lastMessage` khi gửi `FAILED`/`UNKNOWN`, chỉ cập nhật `lastMessageDirection = "OUTBOUND"` khi `SENT`, và trả `conversation` mới nhất ngay trong response HTTP `200`.
4. **Chuẩn hóa media Telegram & đồng hồ mili-giây:** `omni-message-normalizer` trích xuất caption và tạo placeholder trung thực cho ảnh/tệp/voice/sticker/video/location/contact (không nuốt tin); chuẩn hóa timestamp khi khách nhắn lại trong cùng giây với phản hồi nhân viên để ca `RESOLVED` luôn tự mở `OPEN`.
5. **Distributed Lock & SSM TTL Cache:**
   - Khóa `PROCESSING -> DONE` dùng `STALE_LOCK_MS = 20_000` (nằm giữa Lambda timeout `10s` và SQS visibility `30s`/`60s`, tránh báo động giả `[NORMALIZER_FAILURE]`).
   - Cache secret SSM (`omni-webhook-ingest`) và bot token (`omni-outbound-sender`) dùng TTL **5 phút** và tự làm mới 1 lần khi bị `403`/`401` do xoay vòng khóa.
6. **Phân tách WebSocket Scope (`portal` vs `simulator`):** `POST /ws-ticket` nhận `clientType`, `omni-ws-handler` lưu lên `OmniWSConnections`, và hàm broadcast chỉ đẩy tin Telegram thật / `CONVERSATION_UPDATED` cho kết nối `portal`.
7. **Tùy chọn khóa Simulator Webhook:** `omni-webhook-ingest` hỗ trợ `REQUIRE_SIMULATOR_AUTH=true` khi nhóm gắn thêm route `/simulator/webhook/{channel}` qua Cognito Authorizer.

---

## 3. Kiểm tra & Đóng gói ở Local

```bash
npm.cmd install           # Cài AWS SDK vào devDependencies để chạy unit test local
npm.cmd run check         # Chạy static check (verify-lambdas) + toàn bộ unit tests
npm.cmd run package:core  # Tạo 5 file ZIP chuẩn POSIX cho 5 Lambda lõi trong dist/core/
```

---

## 4. Checklist Hạ tầng AWS Tối thiểu Cho Các Thành Viên

- **Vi (Member 2 — Lead / Security / Cost):** Tạo trước 2 tham số SSM (`SecureString`), Cognito User Pool (`omniinbox-agent-pool`, tắt self-registration, tạo 2 user `--permanent`), và 6 IAM Role. Lưu ý cập nhật sơ đồ Draw.io khớp 100% thực tế (bỏ mũi tên `9` tới Simulator, thêm mũi tên `omni-api-handler -> WebSocket API`, tách 4 bảng DynamoDB, đánh dấu AI nét đứt nếu có / bỏ nếu No-Go).
- **Trung Nam (Member 5 — Observability):** Tạo **TRƯỚC** Log Group `/aws/lambda/omni-*` với **retention 7 ngày**; tạo 2 Alarm (`DLQ >= 1` và metric filter `[NORMALIZER_FAILURE]`).
- **Hoài Nam (Member 3 — Inbound & REST):** Tạo 4 bảng DynamoDB (`OmniConversations` + GSI `gsi-all-by-time`, `OmniMessages`, `OmniIdempotency` TTL, `OmniWSConnections` TTL), SQS + DLQ (khuyến nghị `60s` / `maxReceiveCount=5`), deploy 3 Lambda từ `fcaj-omniinbox-backend` (`main`), REST API Gateway + Cognito Authorizer + Gateway Responses CORS + throttling `20/40`.
- **Duy (Member 4 — WS, Outbound & Hosting):** Tạo Telegram Bot và tự nạp token vào SSM, deploy `omni-ws-handler` + `omni-outbound-sender` từ `fcaj-omniinbox-backend` (`main`), chạy `setWebhook` kèm `secret_token`, và tạo S3 private + CloudFront OAC (custom error `403/404 -> /index.html`). Cập nhật `ALLOWED_ORIGIN` sang domain CloudFront.
