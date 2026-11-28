# Cấu trúc 4 Bảng DynamoDB (`database-schema.md`)

Hệ thống dùng **4 bảng Amazon DynamoDB** cấu hình **On-Demand** tại Region `ap-southeast-1`. Dưới đây là cấu trúc thực tế đang được 6 hàm Lambda đọc/ghi.

---

## 1. Bảng tổng hợp

| Tên bảng | Partition Key | Sort Key | GSI | TTL Attribute |
| :--- | :--- | :--- | :--- | :--- |
| `OmniConversations` | `conversationId` (String) | *Không* | `gsi-all-by-time` (PK: `gsi1pk`, SK: `lastMessageAt`, All) | *Không* |
| `OmniMessages` | `conversationId` (String) | `messageId` (String) | *Không* | *Không* |
| `OmniIdempotency` | `messageKey` (String) | *Không* | *Không* | `ttl` (Number) |
| `OmniWSConnections` | `connectionId` (String) | *Không* | *Không* | `ttl` (Number) |

*(Khuyến nghị bật Point-in-time recovery — PITR cho `OmniConversations` và `OmniMessages` khi lên môi trường chạy thật.)*

---

## 2. Chi tiết từng bảng

### 2.1. `OmniConversations`
Mỗi khách hàng trên một kênh có một bản ghi riêng theo `CONV#<channel>#<customerId>`, giúp phân biệt rõ kể cả khi hai khách trùng tên hiển thị.

```json
{
  "conversationId": "CONV#telegram#678901234",
  "gsi1pk": "CONV",
  "channel": "telegram",
  "customerId": "678901234",
  "customerName": "Nguyễn Văn A",
  "lastMessage": "Shop ơi mẫu áo khoác này còn size L không ạ?",
  "lastMessageAt": "2026-11-22T08:30:00.123Z",
  "lastMessageId": "MSG#1732264200123#998877",
  "lastMessageDirection": "INBOUND",
  "lastInboundAt": "2026-11-22T08:30:00.123Z",
  "status": "OPEN",
  "assignedAgent": "unassigned",
  "unreadCount": 1
}
```

- `gsi1pk` và `lastMessageId` là trường nội bộ phục vụ query GSI và đối chiếu tranh chấp ghi; cả 3 hàm (`api-handler`, `normalizer`, `outbound-sender`) đều bỏ 2 trường này trước khi trả dữ liệu cho frontend.
- `status`: nhận một trong 3 giá trị `OPEN`, `IN_PROGRESS`, `RESOLVED`.
- `lastMessageDirection`: `INBOUND` hoặc `OUTBOUND`, dùng để frontend biết khách có đang đợi shop trả lời hay không.

### 2.2. `OmniMessages`
Lưu toàn bộ tin nhắn đến và đi của từng hội thoại, sắp xếp tự nhiên theo `messageId`.

```json
{
  "conversationId": "CONV#telegram#678901234",
  "messageId": "MSG#1732264200123#998877",
  "channel": "telegram",
  "channelMessageId": "998877",
  "direction": "INBOUND",
  "senderId": "678901234",
  "senderName": "Nguyễn Văn A",
  "content": "Shop ơi mẫu áo khoác này còn size L không ạ?",
  "mediaType": "photo",
  "status": "RECEIVED",
  "deliveredVia": "telegram",
  "agentId": "agent.minh@omniinbox.local",
  "errorDetail": null,
  "createdAt": "2026-11-22T08:30:00.123Z",
  "retriedAt": "2026-11-22T08:31:00.000Z",
  "clientSentAtMs": 1732264200000
}
```

- **Quy tắc đặt `messageId` (13 chữ số epoch ms ở đầu):**
  - Tin khách gửi (`INBOUND`): `MSG#<13-digit-epoch-ms>#<channelMessageId>` — luôn ra cùng một key khi SQS retry để `ConditionExpression: attribute_not_exists(messageId)` chặn trùng tuyệt đối.
  - Tin nhân viên gửi (`OUTBOUND`): `MSG#<epoch-ms>#OUT-<requestId>` (nếu frontend gửi kèm `requestId`) hoặc `MSG#<epoch-ms>#OUT-<uuid>`.
- `status`: `RECEIVED` cho tin đến; `SENDING`, `SENT`, `FAILED`, `UNKNOWN` cho tin gửi đi.
- `mediaType` *(tùy chọn cho Telegram)*: `photo`, `document`, `voice`, `audio`, `video`, `sticker`, `location`, `contact`.
- `content` giới hạn tối đa `4000` ký tự; preview `lastMessage` khi nhân viên trả lời gắn tiền tố `"[NV] "` và cắt tối đa `200` ký tự.

### 2.3. `OmniIdempotency` (dùng chung 2 mục đích với TTL)
1. **Khóa chống trùng tin đến (TTL 24 giờ):**
   - `messageKey`: `telegram#<chat.id>#<message_id>` (Telegram bắt buộc kèm `chat.id` vì `message_id` chỉ duy nhất trong từng cuộc chat) hoặc `<channel>#<customerId>#<externalMessageId>` cho kênh mô phỏng.
   - `state`: `PROCESSING` (lưu kèm `lockedAt`) → chuyển sang `DONE` (lưu `doneAt`) sau khi `TransactWrite` thành công.
2. **Vé kết nối WebSocket (TTL 5 phút, hạn logic 60 giây):**
   - `messageKey`: `WSTICKET#<uuid>`, kèm `agent`, `clientType` (`portal` | `simulator`) và `expiresAt` (`now + 60_000`).
   - Vì cơ chế TTL của DynamoDB có thể xóa chậm, `omni-ws-handler` luôn tự kiểm tra `expiresAt` trong code ngay khi tiêu thụ vé.

### 2.4. `OmniWSConnections`
Lưu danh sách tab trình duyệt đang mở kết nối WebSocket (`ttl = nowSec + 3 giờ`, dài hơn thời lượng kết nối tối đa 2 giờ của API Gateway WebSocket).

```json
{
  "connectionId": "AbCdEf123456=",
  "agent": "agent.minh@omniinbox.local",
  "clientType": "portal",
  "connectedAt": "2026-11-22T08:29:00.000Z",
  "ttl": 1732275000
}
```

---

## 3. Các quy tắc xử lý đồng thời quan trọng

1. **Mở lại hội thoại `RESOLVED` và xử lý trùng giây Telegram:** Khi khách nhắn lại vào hội thoại đang `RESOLVED`, `omni-message-normalizer` tự chuyển trạng thái về `OPEN` và giữ nguyên `assignedAgent`. Vì timestamp `msg.date` của Telegram chỉ tính theo giây, code giữ mốc mili-giây tăng thêm (`<= (telegramDateSec + 1) * 1000 - 1`) nếu tin mới đến ngay sau tin phản hồi của nhân viên trong cùng một giây.
2. **Thử lại `TransactWriteItems` tối đa 3 lần:** Nếu lúc normalizer chuẩn bị ghi thì nhân viên vừa `PATCH` đổi `status` của hội thoại, transaction hủy do `ConditionalCheckFailed` → hàm đọc lại snapshot mới nhất và thử lại.
3. **Bảo toàn `unreadCount` và `lastMessage` khi gửi lỗi hoặc có tin xen ngang:** Trong `omni-outbound-sender`, nếu Telegram trả `FAILED` hoặc timeout (`UNKNOWN`) thì giữ nguyên `unreadCount`, `lastMessage` và trạng thái `OPEN`; nếu gửi `SENT` nhưng phát hiện có tin mới đến lúc đang chờ Telegram thì chỉ cập nhật lại preview mà không xóa mất `unreadCount`.
