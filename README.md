# OmniInbox Backend — AWS Lambda Functions (`Node.js 22.x / arm64`)

Mã nguồn backend Serverless Event-Driven cho hệ thống **OmniInbox** (AWS First Cloud Journey — Region `ap-southeast-1`). Toàn bộ **5 hàm Lambda lõi** (+ **1 hàm AI Pha 2 tùy chọn**) được viết thuần **ESM (`index.mjs`)**, chỉ dùng `node:*` và `@aws-sdk/*` có sẵn trong runtime AWS Lambda `Node.js 22.x`, giúp các thành viên phụ trách AWS dễ dàng **copy-paste trực tiếp** vào Lambda Console hoặc **upload `.zip` chuẩn POSIX**.

---

## 1. Danh mục 6 Hàm Lambda & Phân công Triển khai AWS

| Tên hàm Lambda | Nhóm | Runtime / Arch / Memory / Timeout | IAM Role (`Vi`) | Chủ sở hữu AWS |
| :--- | :---: | :--- | :--- | :--- |
| `omni-webhook-ingest` | **Lõi** | `nodejs22.x` · `arm64` · `128 MB` · `5 s` | `omni-ingest-role` | **Hoài Nam** |
| `omni-message-normalizer` | **Lõi** | `nodejs22.x` · `arm64` · `256 MB` · `5 s` | `omni-normalizer-role` | **Hoài Nam** |
| `omni-api-handler` | **Lõi** | `nodejs22.x` · `arm64` · `128 MB` · `10 s` | `omni-api-role` | **Hoài Nam** |
| `omni-ws-handler` | **Lõi** | `nodejs22.x` · `arm64` · `128 MB` · `10 s` | `omni-ws-role` | **Duy** |
| `omni-outbound-sender` | **Lõi** | `nodejs22.x` · `arm64` · `256 MB` · `15 s` | `omni-outbound-role` | **Duy** |
| `omni-ai-suggester` | **Pha 2 (Tùy chọn)** | `nodejs22.x` · `arm64` · `256 MB` · `15 s` | `omni-ai-role` | **Duy** *(chỉ deploy nếu Go Ngày 9)* |

> [!CAUTION]
> **Không deploy `omni-ai-suggester` trước cổng Go/No-Go Ngày 9** và tuyệt đối không hard-code model đã ngừng hỗ trợ (`claude-3-haiku`); nếu Go ở Ngày 9, phải kiểm tra model đang `ACTIVE` qua `aws bedrock list-foundation-models --region ap-southeast-1`.

---

## 2. Các Cải tiến & Điểm Chốt Liên Nhóm Đã Tích hợp Sẵn

1. **UUID-safe `resolveAgentId()` (Amendment #1):** Trong cả `omni-api-handler`, `omni-outbound-sender` và frontend `auth.js`, nếu Cognito sinh `cognito:username` dạng UUID (khi bật Email sign-in), hệ thống tự ưu tiên lấy `claims.email` để khớp `VITE_AGENT_LIST`.
2. **Bảo vệ `unreadCount` & `lastMessage` khi gửi tin lỗi hoặc có tin xen giữa (Amendment #2):**
   - Trong `omni-outbound-sender`, khi gửi Telegram bị `FAILED`, hàm **không** xóa `unreadCount` về `0` và **không** ghi đè `lastMessage` / `lastMessageAt`.
   - Khi gửi `SENT`, hàm kiểm tra `ConditionExpression: "lastMessageAt = :prevLma"`; nếu có tin khách mới vừa đến trong lúc đợi Telegram API, preview được cập nhật nhưng `unreadCount > 0` vẫn được giữ nguyên.
3. **Chống ghi đè bàn giao A -> B & ẩn `gsi1pk` (Amendment #3):**
   - `omni-outbound-sender` chỉ auto-claim `assignedAgent` khi đang `unassigned` bằng conditional `UpdateCommand` (`assignedAgent = :unassigned`), không bao giờ ghi đè nếu đồng nghiệp vừa nhận bàn giao trong lúc gửi Telegram.
   - Mọi sự kiện WebSocket (`NEW_MESSAGE`, `CONVERSATION_UPDATED`, `OUTBOUND_MESSAGE`) và REST API đều lọc bỏ trường nội bộ `gsi1pk`.
4. **An toàn Idempotency & Fault Injection:**
   - Khóa idempotency Telegram bắt buộc kèm `chat.id` (`telegram#<chat.id>#<message_id>`).
   - Trạng thái `PROCESSING` (khóa 40s > SQS visibility 30s) -> `DONE`; không bỏ sót tin khi retry.
   - `forceError: true` chỉ ném lỗi DLQ khi `ENABLE_FAULT_INJECTION="true"`.

---

## 3. Kiểm tra & Đóng gói ở Local

```bash
npm.cmd install       # Cài AWS SDK vào devDependencies để chạy unit test local
npm.cmd run check     # Chạy static check (verify-lambdas) + toàn bộ unit tests
npm.cmd run package:core  # Tạo 5 file ZIP chuẩn POSIX cho 5 Lambda lõi trong dist/
```

Mỗi hàm được thiết kế không phụ thuộc file ngoài nên:
- **Cách A (Nhanh nhất trên AWS Console):** Mở `functions/<ten-ham>/index.mjs`, copy toàn bộ nội dung dán vào `index.mjs` trên Lambda Console và bấm **Deploy**.
- **Cách B (Upload ZIP / AWS CLI):** Chạy `npm.cmd run package:core` -> upload file `dist/<ten-ham>.zip` (đã đặt sẵn quyền file `0644` và để `index.mjs` ở gốc ZIP).

---

## 4. Checklist Hạ tầng AWS Tối thiểu Cho Các Thành Viên

- **Vi (Member 2 — Lead / Security / Cost):** Tạo trước 2 tham số SSM (`SecureString`), Cognito User Pool (`omniinbox-agent-pool`, tắt self-registration, tạo 2 user `--permanent`), và 6 IAM Role theo bảng trên.
- **Trung Nam (Member 5 — Observability):** Tạo **TRƯỚC** Log Group `/aws/lambda/omni-*` với **retention 7 ngày** trước khi deploy code để tránh mặc định *Never expire*; tạo 2 Alarm (`DLQ >= 1` và metric filter `[NORMALIZER_FAILURE]`).
- **Hoài Nam (Member 3 — Inbound & REST):** Tạo 4 bảng DynamoDB (`OmniConversations` + GSI `gsi-all-by-time`, `OmniMessages`, `OmniIdempotency` TTL, `OmniWSConnections` TTL), SQS + DLQ (`30s` / `maxReceiveCount=5`), deploy 3 Lambda (`ingest`, `normalizer` batch 5 + ReportBatchItemFailures + concurrency 5, `api-handler`), REST API Gateway + Cognito Authorizer bắt buộc + Gateway Responses CORS + throttling `20/40`.
- **Duy (Member 4 — WS, Outbound & Hosting):** Tạo Telegram Bot và tự nạp token vào SSM, deploy `omni-ws-handler` + WebSocket API (`prod`), deploy `omni-outbound-sender`, chạy `setWebhook` kèm `secret_token`, và tạo S3 private + CloudFront OAC (custom error `403/404 -> /index.html`). Sau khi có domain CloudFront thật, Hoài Nam & Duy cập nhật `ALLOWED_ORIGIN` từ `*` sang domain CloudFront.
