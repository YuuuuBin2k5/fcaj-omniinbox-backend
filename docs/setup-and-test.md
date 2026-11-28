# Cài đặt Local, Kiểm thử & Đóng gói ZIP (`setup-and-test.md`)

Hướng dẫn chạy test toàn bộ 6 hàm Lambda ở máy cá nhân (không cần tài khoản AWS), đóng gói file `.zip` chuẩn upload và bộ lệnh kiểm tra nhanh sau khi deploy lên AWS.

---

## 1. Chạy ở Local (Node.js >= 22.0.0)

Trên Windows PowerShell, dùng `npm.cmd`:

```powershell
npm.cmd install          # Cài @aws-sdk/* vào devDependencies để chạy unit test
npm.cmd run verify       # Kiểm tra cú pháp ESM, import tự chứa, không lộ secret/model EOL
npm.cmd test             # Chạy toàn bộ 54 unit test bằng node:test
npm.cmd run check        # Chạy liên hoàn cả verify và test (luôn chạy trước khi push PR)
npm.cmd run package:core # Đóng gói 5 Lambda lõi -> dist/core/*.zip
npm.cmd run package      # Đóng gói đủ 6 Lambda (gồm AI Pha 2) -> dist/all/*.zip
```

> Ghi chú đóng gói: Script [package-lambdas.mjs](../scripts/package-lambdas.mjs) tự nén file `index.mjs` đặt ở **gốc file `.zip`** với quyền POSIX `0644` (`0o100644 << 16`), tránh tình trạng Windows nén mất quyền thực thi hoặc lồng thêm thư mục con khi upload lên AWS Lambda.

---

## 2. Danh sách 8 bộ Unit Test & Fixtures

Các bài test dùng `createHandler(deps)` để mock DynamoDB, SQS, SSM, WebSocket và `fetch` (riêng 2 bộ cuối kiểm tra script đóng gói ZIP và mẫu SAM):

| File test | Hàm / thành phần kiểm thử | Số lượng test |
| :--- | :--- | :---: |
| [tests/webhook-ingest.test.mjs](../tests/webhook-ingest.test.mjs) | `omni-webhook-ingest` (CORS, secret rotation, 64KB, base64, auth simulator) | 9 |
| [tests/message-normalizer.test.mjs](../tests/message-normalizer.test.mjs) | `omni-message-normalizer` (media Telegram, idempotency 2 pha, reopen `OPEN`, CAS, DLQ fault) | 11 |
| [tests/api-handler.test.mjs](../tests/api-handler.test.mjs) | `omni-api-handler` (chặn `401` khi thiếu JWT claims, HTTP v2 `routeKey`, UUID-safe agent, query GSI, filter paging, `PATCH` `409`, `ws-ticket`) | 11 |
| [tests/ws-handler.test.mjs](../tests/ws-handler.test.mjs) | `omni-ws-handler` (`$connect` ticket 1 lần, epoch s/ms, `clientType`, `$disconnect`, `PONG`) | 4 |
| [tests/outbound-sender.test.mjs](../tests/outbound-sender.test.mjs) | `omni-outbound-sender` (khóa phân công `409`, `requestId` replay, retry `FAILED`, lọc kết nối WS hết hạn TTL, giữ `lastMessageAt` khi đang gửi, token refresh `401`, giữ `unreadCount`) | 12 |
| [tests/ai-suggester.test.mjs](../tests/ai-suggester.test.mjs) | `omni-ai-suggester` (chặn XML injection `<>`, đọc 5 tin từ DB, giải mã `isBase64Encoded`, fallback trung thực) | 4 |
| [tests/package-lambdas.test.mjs](../tests/package-lambdas.test.mjs) | `scripts/package-lambdas.mjs` (nén `index.mjs` ở gốc `.zip`, quyền POSIX `0644`, gói `core`/`all`) | 2 |
| [tests/infra-template.test.mjs](../tests/infra-template.test.mjs) | `infra/template.yaml` (kiểm tra cấu trúc SAM: 4 bảng DynamoDB, SQS/DLQ, 6 IAM Role, 5+1 Lambda, 2 Alarm, không lộ secret) | 1 |

Dữ liệu mẫu đầu vào đặt tại [fixtures/telegramUpdate.json](../fixtures/telegramUpdate.json) và [fixtures/simulatorPayload.json](../fixtures/simulatorPayload.json).

---

## 3. Lệnh kiểm thử nhanh sau khi deploy lên AWS

Thay `<REST_URL>` (`https://<REST_API_ID>.execute-api.ap-southeast-1.amazonaws.com/prod`), `<WS_URL>` (`wss://<WS_API_ID>.execute-api.ap-southeast-1.amazonaws.com/prod`) và `<ID_TOKEN>` bằng giá trị thật trên môi trường nhóm. Không dán token hay secret thật vào báo cáo.

### 3.1. Kiểm tra chặn truy cập chưa đăng nhập & webhook sai secret
```bash
# Kỳ vọng 401 (thiếu Cognito JWT)
curl -i "<REST_URL>/conversations"

# Kỳ vọng 403 (Telegram thiếu header secret)
curl -i -X POST "<REST_URL>/webhook/telegram" \
  -H "Content-Type: application/json" \
  -d '{"message":{"message_id":1,"chat":{"id":1},"text":"hi"}}'

# Kỳ vọng từ chối (WebSocket thiếu ticket)
npx wscat -c "<WS_URL>"
```

### 3.2. Kiểm tra gửi tin Simulator & chống trùng lặp
```bash
# Gửi 2 lần liên tiếp cùng customerId và externalMessageId -> DB chỉ lưu 1 tin
curl -s -X POST "<REST_URL>/webhook/shopee" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"shopee_user_889","customerName":"Trần Thị Bích","externalMessageId":"dup_test_01","text":"Shop còn size M không?","sentAtMs":1732264200000}'
```

### 3.3. Kiểm tra luồng lỗi DLQ & Alarm
1. Đảm bảo `omni-inbound-dlq` đang rỗng và 2 CloudWatch Alarm đều ở trạng thái `OK`.
2. Đặt tạm `ENABLE_FAULT_INJECTION="true"` trên `omni-message-normalizer`.
3. Gửi payload lỗi:
   ```bash
   curl -i -X POST "<REST_URL>/webhook/shopee" \
     -H "Content-Type: application/json" \
     -d '{"customerId":"fault_user_01","externalMessageId":"fault_01","text":"boom","forceError":true}'
   ```
4. Đợi tin rơi sang `omni-inbound-dlq` (khoảng 2–3 phút với SQS visibility `30s`, hoặc ~5 phút với `60s`) và kiểm tra log `[NORMALIZER_FAILURE]` + email SNS.
5. **Xong bước test nhớ tắt ngay `ENABLE_FAULT_INJECTION="false"`**, Purge DLQ và chờ Alarm về `OK`.
