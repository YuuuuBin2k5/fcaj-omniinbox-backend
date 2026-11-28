# Đặc tả REST API, WebSocket & Sự kiện (`api-spec.md`)

Tài liệu này chốt chính xác đường dẫn, tham số đầu vào/đầu ra và mã lỗi giữa Backend với Frontend (`Agent Portal` và `Simulator`).

---

## 1. Quy ước chung

- **REST Base URL:** `https://<REST_API_ID>.execute-api.ap-southeast-1.amazonaws.com/prod`
- **WebSocket URL:** `wss://<WS_API_ID>.execute-api.ap-southeast-1.amazonaws.com/prod?ticket=<uuid>`
- **Header xác thực (6 route bảo vệ):** `Authorization: <ID_TOKEN>` *(hỗ trợ cả dạng gửi thẳng token hoặc có tiền tố `Bearer `)*.
- **Mã hóa `conversationId`:** Vì `conversationId` có dấu `#` (ví dụ `CONV#telegram#678901234`), khi đưa vào path URL phải gọi `encodeURIComponent` thành `CONV%23telegram%23678901234`.
- **CORS:** Cho phép các header `Content-Type,Authorization`, domain lấy theo biến môi trường `ALLOWED_ORIGIN` (`*` lúc dev, domain CloudFront khi lên production). Mọi HTTP Lambda đều trả `200` cho `OPTIONS`.

---

## 2. Danh sách 7 REST API

### 2.1. `POST /webhook/{channel}` — Nhận tin từ Telegram hoặc Simulator *(Public)*
- **Lambda:** `omni-webhook-ingest` *(cũng hỗ trợ route tùy chọn `/simulator/webhook/{channel}` nếu gắn Cognito Authorizer)*.
- **Kênh hợp lệ:** `telegram`, `shopee`, `zalo`, `webchat` (kênh khác → `404`).
- **Kiểm tra nguồn gọi:**
  - `telegram`: phải có header `X-Telegram-Bot-Api-Secret-Token` khớp secret trong SSM (sai → `403`).
  - `shopee` / `zalo` / `webchat`: chỉ nhận khi `ALLOW_SIMULATOR === "true"` (tắt → `403`); nếu đặt `REQUIRE_SIMULATOR_AUTH === "true"` thì bắt buộc có Cognito claims (`401`).
- **Giới hạn body:** Tối đa `64 KB` (`413`), bắt buộc JSON object (`400`), hỗ trợ `isBase64Encoded`.
- **Response `200`:**
  ```json
  { "ok": true, "status": "QUEUED", "channel": "shopee" }
  ```

### 2.2. `GET /conversations` — Lấy danh sách hội thoại *(Cognito)*
- **Lambda:** `omni-api-handler`
- **Query params:** `channel`, `status` (`OPEN` | `IN_PROGRESS` | `RESOLVED`), `limit` (`1..100`, mặc định `50`), `nextToken` (`base64url`).
- **Ghi chú kỹ thuật:** Query qua GSI `gsi-all-by-time` mới nhất trước. Khi có `channel` hoặc `status`, DynamoDB lọc sau khi áp `Limit` nên code tự lặp tối đa `5` trang (`MAX_FILTER_PAGES`) để gom đủ dữ liệu trả về.
- **Response `200`:**
  ```json
  {
    "conversations": [
      {
        "conversationId": "CONV#telegram#678901234",
        "channel": "telegram",
        "customerId": "678901234",
        "customerName": "Nguyễn Văn A",
        "lastMessage": "Shop ơi còn size L không?",
        "lastMessageAt": "2026-11-22T08:30:00.123Z",
        "lastMessageDirection": "INBOUND",
        "lastInboundAt": "2026-11-22T08:30:00.123Z",
        "status": "OPEN",
        "assignedAgent": "unassigned",
        "unreadCount": 1
      }
    ],
    "nextToken": null
  }
  ```

### 2.3. `GET /conversations/{conversationId}/messages` — Lấy lịch sử tin nhắn *(Cognito)*
- **Lambda:** `omni-api-handler`
- **Query params:** `limit` (`1..100`, mặc định `50`), `nextToken`.
- **Response `200`:** `{ "conversationId": "CONV#...", "messages": [ ... ], "nextToken": null }` *(tin trả theo thứ tự thời gian cũ → mới để render khung chat)*.

### 2.4. `PATCH /conversations/{conversationId}` — Cập nhật trạng thái / phân công / đã đọc *(Cognito)*
- **Lambda:** `omni-api-handler`
- **Body (cần ít nhất 1 trường cập nhật):**
  ```json
  {
    "status": "IN_PROGRESS",
    "assignedAgent": "agent.minh@omniinbox.local",
    "unreadCount": 0,
    "expectedAssignedAgent": "unassigned",
    "expectedLastMessageAt": "2026-11-22T08:30:00.123Z"
  }
  ```
- **Lưu ý:** Nếu truyền `expectedAssignedAgent` hoặc `expectedLastMessageAt` mà dữ liệu trên DB đã thay đổi, trả `409` kèm `{ "error": "...", "conversation": { ... } }` để UI đồng bộ lại trạng thái mới nhất. Khi thành công sẽ phát sự kiện `CONVERSATION_UPDATED`.

### 2.5. `POST /messages/reply` — Nhân viên gửi phản hồi *(Cognito)*
- **Lambda:** `omni-outbound-sender`
- **Body:**
  ```json
  {
    "conversationId": "CONV#telegram#678901234",
    "content": "Dạ shop còn size L ạ!",
    "retryOfMessageId": "MSG#1732264250000#OUT-...",
    "requestId": "1732264250000-550e8400-e29b-41d4-a716-446655440000"
  }
  ```
- **Quy tắc quan trọng:**
  - Kênh gửi và `recipientId` do backend tự tách từ `conversationId`, `agentId` lấy từ Cognito JWT.
  - Nếu hội thoại thuộc nhân viên khác → trả `409 CONVERSATION_ASSIGNED_TO_OTHER`.
  - Nếu `requestId` (`^\d{13}-<UUID>$`) bị gửi trùng → trả lại bản ghi sẵn có mà không gọi Telegram lần 2.
  - Chỉ cho phép `retryOfMessageId` với tin `OUTBOUND` đang ở trạng thái `FAILED` (`SENDING`/`UNKNOWN` bị chặn `409`).
- **Response `200`:** `{ "ok": true, "message": { ... }, "conversation": { ... } }` (`ok = false` nếu Telegram `FAILED` hoặc `UNKNOWN`).

### 2.6. `POST /ws-ticket` — Xin vé kết nối WebSocket *(Cognito)*
- **Lambda:** `omni-api-handler`
- **Body (tùy chọn):** `{ "clientType": "portal" | "simulator" }` *(mặc định `"portal"`)*.
- **Response `200`:** `{ "ticket": "<uuid>", "expiresAt": 1732264265000, "clientType": "portal" }` *(vé có hạn 60 giây)*.

### 2.7. `POST /ai/suggest` — Gợi ý 3 câu trả lời *(Pha 2 tùy chọn, Cognito)*
- **Lambda:** `omni-ai-suggester`
- **Body:** `{ "conversationId": "CONV#..." }` *(backend tự query 5 tin nhắn gần nhất trong DynamoDB, không nhận text tự do từ client)*.
- **Response `200`:**
  ```json
  {
    "suggestions": ["Câu 1", "Câu 2", "Câu 3"],
    "source": "bedrock"
  }
  ```
  *(Khi `BEDROCK_MODEL_ID` rỗng hoặc Bedrock lỗi sẽ trả `source: "fallback"` kèm `reason` và 3 câu mẫu cố định để UI hiện nhãn trung thực.)*

---

## 3. WebSocket & 3 Sự kiện Realtime

- **`$connect` (`omni-ws-handler`):** Kiểm tra `?ticket=<uuid>`, xóa có điều kiện khỏi `OmniIdempotency` (chỉ dùng được 1 lần), kiểm tra `expiresAt`, lưu vào `OmniWSConnections` kèm `clientType`.
- **`$disconnect`:** Xóa bản ghi `connectionId`.
- **`$default`:** Frontend gửi `{"action":"ping"}` mỗi 5 phút → trả `{"event":"PONG"}`.

| Tên sự kiện | Khi nào phát | Nội dung payload | Ai nhận được |
| :--- | :--- | :--- | :--- |
| `NEW_MESSAGE` | Normalizer lưu xong tin khách | `{ event, conversation, message }` | Chỉ `clientType = "portal"` |
| `OUTBOUND_MESSAGE` | Outbound gửi xong (`SENT`/`FAILED`/`UNKNOWN`) | `{ event, conversation, message }` | `telegram`: chỉ `portal`; kênh mô phỏng: cả `portal` & `simulator` |
| `CONVERSATION_UPDATED` | Sau `PATCH /conversations/{id}` | `{ event, conversation }` | Chỉ `clientType = "portal"` |

---

## 4. Tóm tắt mã lỗi HTTP

| Mã | Nguyên nhân thường gặp |
| :---: | :--- |
| `400` | Sai định dạng JSON, thiếu/sai `conversationId`, `status`, `unreadCount`, `requestId`, hoặc retry tin không ở trạng thái `FAILED` |
| `401` | Thiếu JWT Cognito, thiếu ticket WebSocket, hoặc ticket sai/hết hạn/đã dùng |
| `403` | Webhook Telegram thiếu/sai `X-Telegram-Bot-Api-Secret-Token` hoặc gọi kênh mô phỏng khi `ALLOW_SIMULATOR` đang tắt |
| `404` | Kênh hoặc route không tồn tại, không tìm thấy hội thoại, hoặc gọi AI cho hội thoại chưa có tin nào |
| `409` | Tranh nhận hội thoại bị chậm hơn đồng nghiệp (`expectedAssignedAgent` / `CONVERSATION_ASSIGNED_TO_OTHER`), hoặc tin đang ở trạng thái `SENDING`/`UNKNOWN` |
| `413` | Payload webhook vượt quá `64 KB` |
| `429` | Vượt ngưỡng throttling `20 rps / burst 40` trên stage `prod` |
| `500` | Thiếu biến môi trường (`INBOUND_QUEUE_URL`), lỗi đọc SSM hoặc lỗi hệ thống |
